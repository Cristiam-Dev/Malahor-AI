---
type: vault-index
format: malahor-markdown-v1
---

# Malahor Vault

Fuente documental canonica de Malahor para conocimiento humano, producto, diseno, arquitectura y SDD. Vive fuera de los repositorios de codigo.

## Uso

- Los agentes leen y escriben exclusivamente mediante el MCP `docs`.
- Las personas piden acciones en lenguaje natural; el agente resuelve proyecto, ruta y versiones sin exponer detalles internos.
- Las personas pueden usar Obsidian, VSCode, el explorador o cualquier editor Markdown.
- Obsidian es un cliente opcional de estos archivos; no es otro storage ni un requisito.
- `docs_open` usa `--app`, la preferencia global o `system`; Windows/WSL convierte las rutas sin API keys ni wrappers.
- Usar Markdown UTF-8, frontmatter YAML y enlaces relativos.
- Usar Mnemo para memoria operativa; el vault conserva conocimiento humano durable.
- No guardar secretos, tokens, passwords, credenciales ni llaves privadas.

## Estructura

- `00-inbox.md`: notas humanas rapidas pendientes de clasificar.
- `projects/<clave-canonica>/`: raiz aislada de cada proyecto.
  - `Product/`: PRD, dominio y PM.
  - `Design/`: sistema y decisiones de diseno.
  - `SDD/`: cambios, arquitectura, testing y decisiones tecnicas.
  - `Discovery/`: hipotesis, historias, casos de uso y definicion previa.
- `templates/`: plantillas reutilizables.
  - `prd.md`: requisitos de producto.
  - `design-system.md`: lenguaje visual.
  - `architecture.md`: arquitectura y decisiones tecnicas.
  - `agent-instructions.md`: reglas operativas para agentes.
  - `testing.md`: estrategia de validacion.

## Regla

El vault complementa Mnemo, no lo reemplaza. No hay fallback documental al repo: si `docs` no puede resolver o escribir la raiz externa, la operacion se bloquea y se diagnostica. Tampoco hay borrado permanente: archivar significa mover dentro del proyecto.

## Principio de documentacion AI-friendly

Contexto antes que codigo. Para cambios no triviales, documentar requisitos, flujo, arquitectura, restricciones, ejemplos y validacion antes de pedir implementacion.
