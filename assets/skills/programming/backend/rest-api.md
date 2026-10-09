# programming/backend/rest-api

## Usar Cuando

- Diseno, implementacion o revision de APIs HTTP/REST, OpenAPI o contratos cliente-servidor.

## Versiones y compatibilidad

- HTTP semantics se basan en RFC 9110; frameworks pueden abstraer detalles, pero no cambian semantica.
- Si ya existe guia interna/API style guide, respetarla salvo que sea insegura o inconsistente.

## Reglas oficiales/canonicas sintetizadas

- Recursos con nombres estables; usar metodos HTTP por semantica: GET seguro, PUT/DELETE idempotentes, POST para creacion/acciones no idempotentes.
- Status codes coherentes: 200/201/202/204, 400/401/403/404/409/412/422/429, 5xx para fallos del servidor.
- Errores con formato estable: codigo de maquina, mensaje seguro, correlation ID si existe.
- Paginacion, filtros, ordenamiento y campos expandibles documentados.
- Cache y conditional requests (`ETag`, `Last-Modified`) cuando mejore rendimiento/consistencia.
- Idempotency keys para pagos, creaciones sensibles o reintentos de cliente.
- Versionado solo con consumidores reales y estrategia de deprecacion.
- OpenAPI como contrato vivo cuando hay varios consumidores.

## Anti-patrones

- `200 OK` para errores.
- Stack traces o detalles internos en respuesta.
- Endpoints RPC disfrazados sin razon (`/doThing`) cuando un recurso expresa mejor el modelo.
- Romper compatibilidad sin version/deprecacion.

## Validacion

- Contract tests o snapshots controlados de OpenAPI.
- Tests de authz por recurso.
- Ejemplos request/response actualizados.
- Pruebas de errores y rate limiting si aplica.

## Referencias oficiales/canonicas

- HTTP Semantics RFC 9110: https://www.rfc-editor.org/rfc/rfc9110
- MDN HTTP: https://developer.mozilla.org/en-US/docs/Web/HTTP
- OpenAPI Specification: https://spec.openapis.org/oas/latest.html
- Microsoft REST API Guidelines: https://github.com/microsoft/api-guidelines
- Google API Improvement Proposals: https://google.aip.dev/
