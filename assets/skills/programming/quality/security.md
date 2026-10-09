# programming/quality/security

## Usar Cuando

- Auth, permisos, inputs, secretos, archivos, dependencias, datos sensibles, CI/CD o infraestructura.

## Versiones y compatibilidad

- Baseline profesional: OWASP ASVS/Cheat Sheets, proveedor cloud y framework concreto.
- Ajustar controles al riesgo, datos, regulacion y superficie expuesta.

## Reglas profesionales

- Validar entradas en boundaries y canonicalizar antes de autorizar/procesar.
- Autorizar por recurso/tenant/accion; no solo por rol global.
- Secretos en secret manager/variables seguras; nunca repo, logs ni imagenes.
- Queries parametrizadas; escapar/encodear output segun contexto.
- CSRF/CORS/cookies segun tipo de cliente y auth.
- Archivos: validar tipo, tamano, extension real, path traversal y almacenamiento.
- Dependencias: lockfiles, audit CVEs explotables, pinning donde sea critico.
- CI/CD: permisos minimos, OIDC para cloud, acciones pinneadas o de confianza.

## Anti-patrones

- Validacion solo frontend.
- Decodificar JWT sin verificar firma/audience/issuer.
- Multi-tenant filtrado solo en UI.
- Logging de PII/tokens.
- Ignorar errores de auth como `404` sin auditar.

## Validacion

- Tests negativos de permisos y tenant isolation.
- Revisar logs y errores por fuga de secretos/PII.
- Dependency scan y secret scan si existen.
- Threat model ligero para cambios sensibles.

## Referencias oficiales/canonicas

- OWASP ASVS: https://owasp.org/www-project-application-security-verification-standard/
- OWASP Cheat Sheets: https://cheatsheetseries.owasp.org/
- GitHub Actions Security Hardening: https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions
- Node.js Security Best Practices: https://nodejs.org/en/learn/getting-started/security-best-practices
