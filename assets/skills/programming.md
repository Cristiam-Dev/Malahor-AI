# programming

Router first-party de Malahor para asistencia de programacion profunda. Usar despues de `specialty-*` cuando la tarea requiere reglas concretas de tecnologia, arquitectura, calidad, DevOps o cloud.

## Versiones y compatibilidad

- Baseline 2026-10: recomendaciones contrastadas con documentacion oficial/canonica vigente.
- Si el proyecto declara versiones distintas, respetar el stack real antes que la regla generica.
- Cuando una recomendacion dependa de version, validar en el lockfile, manifiesto, docs oficiales o changelog.

## Flujo profesional

1. Ejecutar `malahor-ai context detect`.
2. Cargar primero `specialty-*` para orientacion general.
3. Cargar despues las skills `programming/*` sugeridas por tecnologia/practica.
4. Leer manifiestos reales: `package.json`, `pom.xml`, `build.gradle*`, `angular.json`, `next.config.*`, `nest-cli.json`, `Dockerfile`, `Chart.yaml`, `kustomization.yaml`, IaC, CI y Sonar.
5. Para cambios no triviales, aplicar SDD: objetivo, contexto, diseno, riesgos, tests, validacion.
6. Registrar decisiones relevantes en Mnemo.

## Mapa

| Caso | Skills |
|---|---|
| Angular | `programming/frontend/angular`, `programming/frontend/typescript` |
| React | `programming/frontend/react`, `programming/frontend/typescript` |
| Next.js | `programming/frontend/nextjs`, `programming/frontend/react`, `programming/frontend/typescript` |
| Java/Spring Boot | `programming/backend/java`, `programming/backend/spring-boot` |
| Node/NestJS | `programming/backend/node`, `programming/backend/nestjs`, `programming/frontend/typescript` |
| REST/API | `programming/backend/rest-api`, `programming/quality/security` |
| Datos | `programming/backend/database` |
| Arquitectura | `hexagonal-architecture`, `clean-architecture`, `solid`, `ddd`, `microservices`, `modular-monolith`, `design-patterns` |
| Calidad | `testing`, `tdd`, `code-review`, `sonarqube`, `clean-code`, `security` |
| DevOps | `docker`, `kubernetes`, `ci-cd`, `observability` |
| Cloud | `aws`, `gcp`, `azure` |

## Reglas globales

- No copiar documentacion oficial ni skills externas: sintetizar en palabras propias.
- Preferir cambios pequenos, verificables y alineados al proyecto existente.
- Documentar trade-offs cuando haya varias opciones razonables.
- Seguridad por defecto: validar entradas, minimizar privilegios, no exponer secretos, probar autorizacion.
- Observabilidad por defecto en backend/infra: logs estructurados, metricas y trazas cuando hay distribucion.

## Referencias oficiales/canonicas

- Angular: https://angular.dev
- React: https://react.dev
- Next.js: https://nextjs.org/docs
- TypeScript: https://www.typescriptlang.org/docs/
- Java: https://docs.oracle.com/en/java/javase/21/
- Spring Boot: https://docs.spring.io/spring-boot/index.html
- NestJS: https://docs.nestjs.com
- HTTP/REST: https://www.rfc-editor.org/rfc/rfc9110, https://developer.mozilla.org/en-US/docs/Web/HTTP
- Docker: https://docs.docker.com/build/building/best-practices/
- Kubernetes: https://kubernetes.io/docs/
- SonarQube: https://docs.sonarsource.com/sonarqube-community-build/
- AWS Well-Architected: https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html
- Google Cloud Architecture Framework: https://cloud.google.com/architecture/framework
- Azure Well-Architected Framework: https://learn.microsoft.com/azure/well-architected/
- OpenTelemetry: https://opentelemetry.io/docs/concepts/
