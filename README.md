# calvOS-reports

Informes de diagnóstico del sistema **calvOS** (Odin 3). Aquí llegan los issues que abre el
colector del sistema (`calvOS-doctor`) cuando el usuario decide enviarlos.

> Este repo **no** lleva código del sistema ni datos de juego. Solo recibe informes técnicos
> redactados (sin rutas personales, usuario, hostname, MAC, IP ni números de serie).

## Por qué un Worker y no un token en la consola

El modo juego no tiene navegador y una imagen de sistema **nunca** debe llevar credenciales. El
cliente solo hace `POST` de un bundle ya redactado; el Worker (que sí guarda el token como
*secret*) abre el issue y devuelve su URL, que la consola pinta como **QR** para abrirlo en el móvil.

```
consola (calvOS)                     Cloudflare Worker                 GitHub
  colector  -- POST JSON -->  valida + redacta + rate limit  -- API -->  issue en este repo
     ^                                                                        |
     +------------------ { ok, issueUrl }  (se pinta como QR) ----------------+
```

## Despliegue (una vez)

1. Instala Wrangler y autentica:

   ```sh
   npm i -g wrangler
   wrangler login
   ```

   (o exporta `CLOUDFLARE_API_TOKEN` con permiso **Workers Scripts: Edit**).

2. Crea un **token de GitHub fine-grained**: solo el repo `arcadematicas/calvOS-reports`,
   permiso **Issues: Read and write** (y Metadata: Read).

3. Guarda el token como secret (no se escribe en ningún fichero):

   ```sh
   wrangler secret put GITHUB_TOKEN
   ```

4. Despliega:

   ```sh
   wrangler deploy
   ```

   Te dará una URL tipo `https://calvos-reports.<tu-subdominio>.workers.dev`.

5. (Opcional, recomendado) rate limit por IP:

   ```sh
   wrangler kv namespace create RL
   # pega el id en wrangler.toml y vuelve a desplegar
   ```

6. Prueba de humo:

   ```sh
   curl -s -X POST "https://calvos-reports.<subdominio>.workers.dev/api/report" \
     -H 'content-type: application/json' \
     -d '{"app":"calvos-doctor","kind":"bug","text":"prueba de humo","environment":{"kernel":"7.2.12"}}'
   ```

   Debe responder `{"ok":true,"issueUrl":"..."}`.

## Contrato de la API

`POST /api/report`

```jsonc
{
  "app": "calvos-doctor",
  "version": "0.1.0",
  "kind": "bug",                    // bug | feature
  "categories": ["audio", "panel"],
  "text": "lo que cuenta el usuario",
  "environment": { "kernel": "7.2.12-16", "bsp": "0.2.0-22" },
  "state": { "panel_hz": 119.9 },
  "logs": ["..."]
}
```

- Límite de payload: **256 KB**. Cuerpo del issue recortado a 60 KB.
- Rate limit: **3 informes/hora por IP** (si hay binding `RL`).
- Respuestas: `201 {ok:true, issueUrl, number}` · `4xx/5xx {ok:false, error}`.
- `GET` devuelve `{ok:true, service:"calvos-reports"}` (health check).

## Privacidad

- El cliente redacta **antes** de enviar y el Worker **vuelve a redactar** (defensa en profundidad).
- Se eliminan: `/home/<usuario>`, `/run/media/<usuario>`, hostname, usuario, MAC, IP y valores de
  claves que suenen a `serial`, `imei`, `ssid`, `token` o `key`.
- Si no hay red, el cliente guarda el informe en el dispositivo y **no** envía nada.

## Estado

- [x] Worker escrito (`worker/src/index.js`)
- [ ] Desplegado
- [ ] Integrado en el panel (primer envío con el modal vendorizado)
- [ ] `calvOS-doctor` propio con categorías de calvOS
