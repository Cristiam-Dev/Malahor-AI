# programming/backend/node

## Usar Cuando

- Backend Node.js con Express, Fastify, Hono, Koa, workers, CLIs o APIs server-side.

## Versiones y compatibilidad

- Baseline 2026-10: Node moderno LTS/current segun proyecto; validar `engines.node`, runtime de despliegue y modulo ESM/CJS.
- Node ejecuta JS en un proceso con I/O asincrono; trabajo CPU pesado debe aislarse.

## Reglas oficiales sintetizadas

- No bloquear el event loop con CPU intenso, sync I/O grande o JSON masivo sin control.
- Validar config/env al arrancar y exponer un objeto tipado; evitar `process.env` disperso.
- Separar handlers HTTP, casos de uso y adaptadores externos.
- Manejo centralizado de errores async; timeouts y aborts para llamadas externas.
- Logs estructurados, correlation/request ID y sin secretos.
- Usar ESM/CJS consistentemente segun package/runtime.
- Seguridad: validar inputs, limitar payloads, headers seguros, rate limiting cuando aplique.

## Anti-patrones

- Middleware global con efectos ocultos.
- Promesas sin `await`/catch en flujos criticos.
- Dependencias directas a DB/proveedores desde handlers complejos.
- Secretos o tokens en logs.

## Validacion

- Tests de handlers/casos de uso.
- Smoke de rutas, errores y timeouts.
- Load/perf test ligero si hay riesgo de event-loop blocking.

## Referencias oficiales

- Node.js Learn: https://nodejs.org/en/learn
- Event Loop: https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick
- Don't Block the Event Loop: https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop
- Security Best Practices: https://nodejs.org/en/learn/getting-started/security-best-practices
