# programming/cloud/aws

## Usar Cuando

- Infraestructura o servicios AWS, IaC, IAM, Lambda, ECS/EKS, S3, RDS, CloudWatch, etc.

## Versiones y compatibilidad

- Baseline 2026-10: AWS Well-Architected Framework 2024+.
- Validar region, servicio, quotas, pricing y compliance del workload.

## Reglas oficiales sintetizadas

- Aplicar pilares Well-Architected: operational excellence, security, reliability, performance efficiency, cost optimization, sustainability.
- IAM de minimo privilegio; preferir roles temporales/OIDC sobre access keys largas.
- Secrets Manager/SSM Parameter Store para secretos y rotacion cuando aplique.
- Observabilidad desde el inicio: CloudWatch logs/metrics/alarms, tracing si aplica.
- Diseñar resiliencia por AZ/region segun criticidad; backups y restore probado.
- Cost allocation tags, budgets y alertas para recursos caros.
- Cifrado en transito y reposo para datos sensibles.

## Anti-patrones

- `AdministratorAccess` para workloads.
- Access keys en CI o repositorio.
- Recursos sin tags ni budgets.
- Backups no probados.

## Validacion

- Revisar IAM policy scope.
- Validar region/AZ, costos, limites y rollback.
- Smoke de observabilidad y restore si hay datos.

## Referencias oficiales

- AWS Well-Architected Framework: https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html
- IAM Best Practices: https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html
- AWS Secrets Manager: https://docs.aws.amazon.com/secretsmanager/
- AWS Observability: https://aws.amazon.com/observability/
