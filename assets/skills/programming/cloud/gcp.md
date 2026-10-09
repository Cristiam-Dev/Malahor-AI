# programming/cloud/gcp

## Usar Cuando

- Infraestructura o servicios Google Cloud, Cloud Run, GKE, IAM, Secret Manager, Cloud Build, etc.

## Versiones y compatibilidad

- Baseline 2026-10: Google Cloud Architecture Framework.
- Validar proyecto, region, cuotas, facturacion y permisos organizacionales.

## Reglas oficiales sintetizadas

- Aplicar pilares del Architecture Framework: operational excellence, security/privacy/compliance, reliability, cost optimization, performance.
- IAM minimo por service account; evitar cuentas de servicio compartidas sin ownership.
- Secret Manager para secretos; Workload Identity/Federation cuando aplique.
- Cloud Logging/Monitoring/Error Reporting/Trace segun workload.
- Separar proyectos/entornos y redes por riesgo/ownership.
- Definir budgets, labels y alertas de costo.
- Backups, DR y SLOs alineados a criticidad.

## Anti-patrones

- Owner/editor amplio por defecto.
- Service account keys largas en CI.
- Proyectos mezclando dev/prod sin aislamiento.
- Recursos sin labels ni budgets.

## Validacion

- Revisar IAM, APIs habilitadas, region y quotas.
- Smoke de logs/metrics/alerts.
- Plan de rollback y restore para datos.

## Referencias oficiales

- Google Cloud Architecture Framework: https://cloud.google.com/architecture/framework
- IAM Best Practices: https://cloud.google.com/iam/docs/using-iam-securely
- Secret Manager: https://cloud.google.com/secret-manager/docs
- Cloud Build: https://cloud.google.com/build/docs
