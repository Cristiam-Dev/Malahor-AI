# specialty-devops

Guia de especialidad para trabajo de devops e infraestructura: CI/CD, contenedores, despliegue y nube (Azure, GCP, AWS).

## Usar Cuando

- Se crean o modifican pipelines de CI/CD (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins).
- Se tocan Dockerfiles, compose, imagenes o registries.
- Se configuran despliegues, entornos, secretos o infraestructura como codigo.
- La tarea pide nube (Azure, GCP, AWS) o el stack detectado incluye devops.

## Preguntas Guia

1. Que debe pasar de automatico (build, test, lint, deploy) y en que orden?
2. Que secretos necesita el pipeline y como llegan sin quedar en texto plano?
3. Que imagen se construye, que entra en ella y como se minimiza?
4. Como se hacen despliegues reversibles (rollback) y como se verifica salud?
5. Que permisos minimos necesita cada etapa o servicio?
6. Que pasa si una etapa falla: se detiene, se notifica, se reintenta?

## Puntos de Revision

- CI: pasos reproducibles, cache donde suma, feedback rapido y claro.
- Imagenes: base fijada por version, capas estables, sin secretos ni artefactos de build dentro.
- CD: despliegues repetibles, ambientes separados, aprobaciones donde haga falta.
- Secretos: siempre via gestor de secretos del sistema; nunca en repos ni logs.
- Observabilidad: salud, logs estructurados y metricas minimas disponibles.
- Infraestructura como codigo cuando el entorno se repite; manual solo para lo unico.

## Anti-Patrones

- Pipelines que hacen de todo sin separar responsabilidades.
- Imagenes gigantes con herramientas de desarrollo incluidas.
- Credenciales en variables de entorno sin cifrar o en archivos del repo.
- Despliegues sin health check ni rollback probado.
- Permisos amplios por defecto en cuentas de servicio.
- Arreglar entornos a mano en lugar de corregir la definicion.

## Salida

- Cambios propuestos en pipelines, imagenes o configuracion.
- Secretos y permisos necesarios, sin valores reales.
- Pasos de verificacion y rollback.
- Decisiones relevantes para guardar en Mnemo.

## Integracion Con SDD

- Usar dentro de `sdd-design` y `sdd-apply` para cambios de infraestructura.
- Documentar la topologia y los entornos afectados antes de ejecutar.
- Guardar decisiones de despliegue o seguridad en Mnemo.
