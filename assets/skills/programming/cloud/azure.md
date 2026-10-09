# programming/cloud/azure

## Usar Cuando

- Infraestructura o servicios Azure, App Service, AKS, Functions, Key Vault, Entra ID, Azure Monitor o Bicep.

## Versiones y compatibilidad

- Baseline 2026-10: Azure Well-Architected Framework.
- Validar suscripcion, region, SKU/pricing tier, RBAC y politicas organizacionales.

## Reglas oficiales sintetizadas

- Aplicar pilares Well-Architected: reliability, security, cost optimization, operational excellence, performance efficiency.
- Managed identities antes que secretos estaticos.
- Key Vault para secretos, certificados y keys.
- RBAC minimo por scope; evitar roles amplios en subscription si basta resource group.
- Azure Monitor/Application Insights/Log Analytics para observabilidad.
- Resource groups y tags por entorno/dominio/ownership.
- Backups, availability zones y DR segun criticidad.

## Anti-patrones

- Connection strings o client secrets en repo.
- Roles Owner/Contributor innecesarios.
- Recursos sin tags ni budgets.
- Produccion sin alertas ni runbooks.

## Validacion

- Revisar RBAC, managed identity, Key Vault access y network exposure.
- Confirmar region, pricing tier, quotas y rollback.
- Smoke de App Insights/logs/alerts.

## Referencias oficiales

- Azure Well-Architected Framework: https://learn.microsoft.com/azure/well-architected/
- Managed Identities: https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/overview
- Azure Key Vault: https://learn.microsoft.com/azure/key-vault/
- Azure Monitor: https://learn.microsoft.com/azure/azure-monitor/
- Azure Bicep: https://learn.microsoft.com/azure/azure-resource-manager/bicep/
