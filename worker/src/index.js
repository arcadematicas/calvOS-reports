/**
 * calvOS-reports — colector de informes de diagnostico de calvOS.
 *
 * POR QUE EXISTE: la consola (modo juego) no tiene navegador y no debe llevar
 * credenciales de GitHub. El cliente solo POSTea un bundle ya redactado; este
 * Worker (que SI guarda el token como secret) abre el issue y devuelve su URL,
 * que el cliente pinta como QR.
 *
 * Seguridad:
 *  - El token vive solo aqui (wrangler secret put GITHUB_TOKEN), con permiso
 *    minimo: Issues = Read and write en UN repositorio.
 *  - Redaccion otra vez en servidor (defensa en profundidad) + topes de tamano.
 *  - Rate limit por IP si hay binding KV (env.RL); si no, se apoya en las
 *    reglas de rate limiting de Cloudflare.
 *
 * Contrato:
 *   POST /api/report  {app, kind?, categories?, text, environment?, state?, logs?, version?}
 *   201 {ok:true, issueUrl}
 *   4xx/5xx {ok:false, error}
 */

const MAX_PAYLOAD = 256 * 1024;
const MAX_BODY = 60000;
const DEFAULT_LABELS = ["informe"];
const RATE_LIMIT = 3;      // informes por IP y hora (si hay KV)
const RATE_TTL = 3600;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "\n… (recortado)" : s);

/** Redaccion defensiva: rutas personales, usuario, hostname, MAC, IP y seriales. */
function redact(text, meta = {}) {
  if (typeof text !== "string") return text;
  let out = text
    .replace(/\/home\/[A-Za-z0-9._-]+/g, "/home/<usuario>")
    .replace(/\/run\/media\/[A-Za-z0-9._-]+/g, "/run/media/<usuario>")
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, "/Users/<usuario>")
    .replace(/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, "<mac>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>");
  if (meta.hostname) out = out.split(meta.hostname).join("<hostname>");
  if (meta.user) out = out.split(meta.user).join("<usuario>");
  return out;
}

function redactDeep(value, meta, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value, meta);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactDeep(v, meta, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 200)) {
      out[redact(k, meta)] = /serial|imei|uuid|ssid|token|key/i.test(k) ? "<redactado>" : redactDeep(v, meta, depth + 1);
    }
    return out;
  }
  return value;
}

function renderBody(p) {
  const parts = [];
  const text = (p.text || "").toString().trim();
  parts.push(text || "_(sin descripcion)_");

  if (p.categories?.length) parts.push("**Categorias:** " + p.categories.join(", "));
  const env = [];
  if (p.app) env.push(["App", p.app]);
  if (p.version) env.push(["Version", p.version]);
  if (p.kind) env.push(["Tipo", p.kind]);
  if (p.platform) env.push(["Plataforma", p.platform]);
  if (env.length) parts.push(env.map(([k, v]) => `- ${k}: \`${v}\``).join("\n"));

  if (p.environment && Object.keys(p.environment).length) {
    parts.push("<details><summary>Entorno</summary>\n\n\`\`\`json\n" +
      clip(JSON.stringify(p.environment, null, 2), 12000) + "\n\`\`\`\n</details>");
  }
  if (p.state && Object.keys(p.state).length) {
    parts.push("<details><summary>Estado del panel</summary>\n\n\`\`\`json\n" +
      clip(JSON.stringify(p.state, null, 2), 12000) + "\n\`\`\`\n</details>");
  }
  const logs = Array.isArray(p.logs) ? p.logs : [];
  if (logs.length) {
    const txt = logs.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
    parts.push("<details><summary>Logs</summary>\n\n\`\`\`\n" + clip(txt, 30000) + "\n\`\`\`\n</details>");
  }
  parts.push("---\n_Generado por el colector de calvOS. Revisa y edita lo que no quieras publicar._");
  return clip(parts.join("\n\n"), MAX_BODY);
}

function titleFor(p) {
  const first = (p.text || "").toString().trim().split("\n")[0] || "informe sin descripcion";
  const short = first.length > 70 ? first.slice(0, 70) + "…" : first;
  return `[${p.kind || "bug"}] ${short}`;
}

async function rateLimited(env, ip) {
  if (!env.RL || !ip) return false;
  const key = `rl:${ip}`;
  const hits = parseInt((await env.RL.get(key)) || "0", 10) || 0;
  if (hits >= RATE_LIMIT) return true;
  await env.RL.put(key, String(hits + 1), { expirationTtl: RATE_TTL });
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return json({ ok: true, service: "calvos-reports", version: 1 });
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    if (!env.GITHUB_TOKEN || !env.GH_REPO) return json({ ok: false, error: "not_configured" }, 503);

    const declared = parseInt(request.headers.get("content-length") || "0", 10);
    if (declared > MAX_PAYLOAD) return json({ ok: false, error: "payload_too_large" }, 413);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: "bad_json" }, 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ ok: false, error: "bad_payload" }, 400);
    }
    const ip = request.headers.get("cf-connecting-ip") || "";
    if (await rateLimited(env, ip)) return json({ ok: false, error: "rate_limited" }, 429);

    const meta = { hostname: payload.hostname, user: payload.user };
    const clean = redactDeep(payload, meta);
    const body = renderBody(clean);
    if (body.length > MAX_BODY) return json({ ok: false, error: "too_large" }, 413);

    const labels = (env.GH_LABELS ? env.GH_LABELS.split(",") : DEFAULT_LABELS).map((s) => s.trim()).filter(Boolean);
    const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "calvos-reports-collector",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: titleFor(clean), body, labels }),
    });

    if (!res.ok) {
      const detail = clip(await res.text(), 400);
      return json({ ok: false, error: "github_error", status: res.status, detail }, 502);
    }
    const issue = await res.json();
    return json({ ok: true, issueUrl: issue.html_url, number: issue.number }, 201);
  },
};
