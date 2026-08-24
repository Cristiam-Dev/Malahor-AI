# Instrucciones Globales - Malahor AI

## Contexto

- Responder siempre en espanol.
- Cargar memoria del proyecto con Mnemo al inicio de cada sesion.
- Tratar `malaho`, `malahor`, `malahor ai`, `malahor-ai` y `Malahor-AI` como el mismo proyecto: `Malahor-AI`.
- No escribir archivos dentro de repos del usuario para configuracion global, memoria, grafos o assets de Malahor.

## Memoria

- Usar Mnemo para decisiones, bugs, patrones, arquitectura, aprendizajes y resumen de sesion.
- Guardar cambios importantes al cerrar una tarea.
- No persistir secretos, tokens, passwords, credenciales ni llaves privadas.

## Obsidian

- Obsidian es solo para documentacion, procesos, conocimiento, notas de diseno, decisiones humanas, guias operativas y material de referencia.
- Operar Obsidian solo mediante Obsidian MCP.
- No buscar ni modificar vaults por filesystem directo.
- Si Obsidian MCP no esta disponible, informar la limitacion.

## Vikunja

- Vikunja es la capa operativa para proyectos, tareas, pendientes, seguimiento y estado de trabajo.
- Buscar proyectos existentes por alias antes de crear duplicados.
- No crear archivos `Tareas.md` en Obsidian.

## Desarrollo

- Antes de editar, leer el contexto del proyecto.
- Preferir cambios pequenos y verificables.
- Para pruebas de Malahor, usar sandbox con `MALAHOR_HOME` y `MALAHOR_OPENCODE_DIR`.
- No tocar el entorno real si existe un sandbox activo.
