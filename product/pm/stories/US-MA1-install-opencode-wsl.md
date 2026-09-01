# US-MA1 - Instalar Malahor en OpenCode desde WSL

## Historia

Como desarrollador que usa OpenCode en WSL, quiero instalar `malahor-ai` con un comando global para habilitar memoria, grafos externos y orquestacion sin configurar archivos manualmente.

## Criterios de aceptacion

- El comando `malahor-ai install` detecta WSL y OpenCode.
- El comando muestra un resumen antes de modificar configuraciones.
- El comando crea backup de `opencode.jsonc` si existe.
- El comando instala Mnemo en `~/.malahor/mnemo/`.
- El comando crea `~/.malahor/graphs/`.
- El comando inyecta el MCP `mnemo` con `type: "local"`, `command` como array y `enabled: true`.
- OpenCode puede iniciar sin `ConfigInvalidError`.

## Estado

Completado.
