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
 *   POST /api/report  {app, kind?, categories?, text, environment?, state?, logs?, ...}
 *   201 {ok:true, issueUrl, number}
 *   4xx/5xx {ok:false, error}
 */

const MAX_PAYLOAD = 256 * 1024;
const MAX_BODY = 60000;
const DEFAULT_LABELS = ["informe"];
const RATE_LIMIT = 3; // informes por IP y hora (si hay KV)
const RATE_TTL = 3600;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const clip = (s, n) =>
  typeof s === "string" && s.length > n ? s.slice(0, n) + "\n… (recortado)" : s;

const codeBlock = (lang, text) =>
  ["```" + lang, text, "```"].join("\n");

const details = (summary, body) =>
  "<details><summary>" + summary + "</summary>\n\n" + body + "\n</details>";

/** Redaccion defensiva: rutas personales, usuario, hostname, MAC e IP. */
function redact(text, meta) {
  if (typeof text !== "string") return text;
  let out = text
    .replace(/\/home\/[A-Za-z0-9._-]+/g, "/home/<usuario>")
    .replace(/\/run\/media\/[A-Za-z0-9._-]+/g, "/run/media/<usuario>")
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, "/Users/<usuario>")
    .replace(/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, "<mac>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>");
  if (meta && meta.hostname) out = out.split(meta.hostname).join("<hostname>");
  if (meta && meta.user) out = out.split(meta.user).join("<usuario>");
  return out;
}

const SENSITIVE_KEY = /serial|imei|uuid|ssid|token|key|password|secret/i;

function redactDeep(value, meta, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value, meta);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactDeep(v, meta, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 200)) {
      out[redact(k, meta)] = SENSITIVE_KEY.test(k) ? "<redactado>" : redactDeep(v, meta, depth + 1);
    }
    return out;
  }
  return value;
}

const RENDERED = new Set([
  "schema", "app", "version", "platform", "kind", "categories",
  "text", "environment", "state", "logs", "hostname", "user",
]);

function renderBody(p) {
  const parts = [];
  const text = (p.text || "").toString().trim();
  parts.push(text || "_(sin descripcion)_");

  if (Array.isArray(p.categories) && p.categories.length) {
    parts.push("**Categorias:** " + p.categories.join(", "));
  }

  const head = [];
  if (p.app) head.push("- App: `" + p.app + "`");
  if (p.version) head.push("- Version: `" + p.version + "`");
  if (p.kind) head.push("- Tipo: `" + p.kind + "`");
  if (head.length) parts.push(head.join("\n"));

  if (p.environment && Object.keys(p.environment).length) {
    parts.push(details("Entorno", codeBlock("json", clip(JSON.stringify(p.environment, null, 2), 12000))));
  }
  if (p.state && Object.keys(p.state).length) {
    parts.push(details("Estado", codeBlock("json", clip(JSON.stringify(p.state, null, 2), 12000))));
  }
  if (Array.isArray(p.logs) && p.logs.length) {
    const txt = p.logs.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
    parts.push(details("Logs", codeBlock("", clip(txt, 30000))));
  }
  // Anexos: lo que el cliente mande de mas (capabilities, stores, journal, kernel, sysfs...)
  for (const [k, v] of Object.entries(p)) {
    if (RENDERED.has(k) || v === null || v === undefined) continue;
    const txt = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    if (!txt || txt === "{}" || txt === "[]") continue;
    parts.push(details(k, codeBlock(typeof v === "string" ? "" : "json", clip(txt, 8000))));
  }
  parts.push("---\n_Generado por el colector de calvOS. Edita lo que no quieras publicar._");
  return clip(parts.join("\n\n"), MAX_BODY);
}

function titleFor(p) {
  const first = (p.text || "").toString().trim().split("\n")[0] || "informe sin descripcion";
  const short = first.length > 70 ? first.slice(0, 70) + "…" : first;
  return "[" + (p.kind || "bug") + "] " + short;
}

async function rateLimited(env, ip) {
  if (!env.RL || !ip) return false;
  const key = "rl:" + ip;
  const hits = parseInt((await env.RL.get(key)) || "0", 10) || 0;
  if (hits >= RATE_LIMIT) return true;
  await env.RL.put(key, String(hits + 1), { expirationTtl: RATE_TTL });
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      return json({ ok: true, service: "calvos-reports", version: 1 });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }
    if (url.pathname !== "/api/report" && url.pathname !== "/") {
      return json({ ok: false, error: "not_found" }, 404);
    }
    if (!env.GITHUB_TOKEN || !env.GH_REPO) {
      return json({ ok: false, error: "not_configured" }, 503);
    }

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

    const env = payload.environment && typeof payload.environment === "object" ? payload.environment : {};
    const meta = {
      hostname: payload.hostname || env.hostname || env.host || "",
      user: payload.user || env.user || env.username || "",
    };
    const clean = redactDeep(payload, meta);
    const body = renderBody(clean);
    if (body.length > MAX_BODY) return json({ ok: false, error: "too_large" }, 413);

    const labels = (env.GH_LABELS ? env.GH_LABELS.split(",") : DEFAULT_LABELS)
      .map((s) => s.trim())
      .filter(Boolean);

    const res = await fetch("https://api.github.com/repos/" + env.GH_REPO + "/issues", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.GITHUB_TOKEN,
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
