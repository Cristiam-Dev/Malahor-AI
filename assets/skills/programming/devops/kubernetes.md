# programming/devops/kubernetes

## Usar Cuando

- Manifiestos Kubernetes, Helm, Kustomize, workloads, services, ingress, RBAC o deploys.

## Versiones y compatibilidad

- Baseline 2026-10: Kubernetes docs actuales; validar version del cluster y APIs disponibles.
- Revisar deprecaciones por version antes de aplicar manifests.

## Reglas oficiales sintetizadas

- Definir `requests` y `limits` de CPU/memoria segun perfil real.
- Probes separadas: `startup` para arranque lento, `readiness` para trafico, `liveness` para recuperacion.
- ConfigMaps para config no sensible; Secrets para secretos, idealmente cifrados/gestionados externamente.
- RBAC minimo necesario; ServiceAccounts por workload si requiere permisos.
- SecurityContext: non-root, filesystem read-only y capabilities minimas cuando sea viable.
- Deployments con rolling update, rollback y PodDisruptionBudget para servicios criticos.
- Labels/annotations consistentes; namespaces y quotas para aislamiento.
- NetworkPolicies si el cluster las soporta y el riesgo lo justifica.

## Anti-patrones

- Sin resource requests/limits.
- Probes que dependen de servicios externos y causan reinicios falsos.
- Secrets en texto plano versionado.
- Pods privilegiados o hostPath sin justificacion.
- `latest` en imagenes de produccion.

## Validacion

- `kubectl apply --dry-run=server` o validacion equivalente.
- `helm template`/`helm lint` si aplica.
- Probar rollout/rollback y health endpoints.
- Revisar RBAC, secrets y resource quotas.

## Referencias oficiales

- Kubernetes Docs: https://kubernetes.io/docs/
- Resource Management: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
- Probes: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
- RBAC: https://kubernetes.io/docs/reference/access-authn-authz/rbac/
- Secrets Good Practices: https://kubernetes.io/docs/concepts/security/secrets-good-practices/
