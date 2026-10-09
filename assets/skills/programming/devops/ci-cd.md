# programming/devops/ci-cd

## Usar Cuando

- Pipelines, releases, GitHub Actions, GitLab CI, Jenkins, Azure Pipelines o publicacion de artefactos.

## Versiones y compatibilidad

- Ajustar a proveedor CI real; esta skill usa GitHub Actions como referencia oficial principal.
- Politicas de ramas, ambientes y secretos pueden depender de la organizacion.

## Reglas oficiales sintetizadas

- Separar jobs/steps: install, lint/typecheck, test, build, package, scan, publish/deploy.
- Permisos minimos por job (`permissions:` en GitHub Actions); elevar solo donde sea necesario.
- Secretos solo en provider CI/secret manager; OIDC para cloud cuando sea posible.
- Pinnear acciones de terceros a SHA o usar proveedores de confianza; auditar acciones nuevas.
- Cache reproducible y no privilegiada; no cachear secretos.
- Artefactos versionados, verificables y trazables a commit/SHA.
- Ambientes con aprobaciones para produccion y rollback documentado.

## Anti-patrones

- `pull_request_target` con checkout de codigo no confiable.
- Tokens con permisos write globales por defecto.
- Scripts inline con input no confiable interpolado.
- Publicar sin tests/build previos.

## Validacion

- Pipeline verde en PR.
- Reproducir build local o sandbox.
- Revisar permisos, secrets, ambientes y artefactos.
- Smoke post-deploy si hay despliegue.

## Referencias oficiales

- GitHub Actions Concepts: https://docs.github.com/en/actions/about-github-actions/understanding-github-actions
- GitHub Actions Security Hardening: https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions
- OpenID Connect: https://docs.github.com/en/actions/concepts/security/openid-connect
- Azure Pipelines Docs: https://learn.microsoft.com/azure/devops/pipelines/
