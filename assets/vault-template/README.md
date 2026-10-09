# Malahor Vault

Vault markdown opcional para documentacion humana, decisiones, patrones y seguimiento de cambios SDD.

## Uso

- Mantener este vault fuera de repositorios de codigo.
- Usar Obsidian para navegar y editar notas.
- Usar Mnemo para memoria operativa del agente.
- No guardar secretos, tokens, passwords, credenciales ni llaves privadas.

## Estructura

- `00-inbox.md`: notas rapidas pendientes de clasificar.
- `projects/`: notas por proyecto.
- `templates/`: plantillas reutilizables.
  - `prd.md`: requisitos de producto.
  - `design-system.md`: lenguaje visual.
  - `architecture.md`: arquitectura y decisiones tecnicas.
  - `agent-instructions.md`: reglas operativas para agentes.
  - `testing.md`: estrategia de validacion.

## Regla

El vault complementa Mnemo, no lo reemplaza. Mnemo guarda contexto operativo consultable por agentes; el vault guarda conocimiento humano navegable.

## Principio de documentacion AI-friendly

Contexto antes que codigo. Para cambios no triviales, documentar requisitos, flujo, arquitectura, restricciones, ejemplos y validacion antes de pedir implementacion.
