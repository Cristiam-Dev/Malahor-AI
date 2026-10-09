# programming/devops/docker

## Usar Cuando

- Dockerfile, compose, imagenes, build/publish de contenedores o packaging runtime.

## Versiones y compatibilidad

- Baseline 2026-10: Docker build best practices oficiales.
- Validar runtime real: Node/Java/Python/Go, arquitectura, distro base y plataforma de despliegue.

## Reglas oficiales sintetizadas

- Multi-stage builds para separar build/runtime y reducir superficie.
- Imagen base confiable, versionada y lo mas pequena posible sin romper debugging/compatibilidad.
- `.dockerignore` para no copiar secretos, caches, tests pesados o artefactos innecesarios.
- Usuario no-root cuando sea viable; permisos minimos en filesystem.
- Instalar dependencias de forma reproducible con lockfiles.
- No inyectar secretos en build args/layers; usar secrets del builder/CI.
- Healthcheck si el orquestador/runtime lo consume.
- Etiquetar imagen con version/SHA y generar SBOM/scan si pipeline lo soporta.

## Anti-patrones

- `latest` como unica referencia.
- Copiar todo el repo sin `.dockerignore`.
- Ejecutar como root por defecto sin razon.
- Secretos en capas, envs o logs de build.

## Validacion

- `docker build` reproducible.
- Smoke test del contenedor.
- Scan de imagen/dependencias si disponible.
- Revisar tamano, usuario, exposed ports y env vars documentadas.

## Referencias oficiales

- Docker Build Best Practices: https://docs.docker.com/build/building/best-practices/
- Multi-stage Builds: https://docs.docker.com/build/building/multi-stage/
- Dockerfile Reference: https://docs.docker.com/reference/dockerfile/
- Docker Compose Docs: https://docs.docker.com/compose/
