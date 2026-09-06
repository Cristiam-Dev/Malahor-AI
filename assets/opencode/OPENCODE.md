# Instrucciones Globales - Malahor AI

## Contexto

- Responder siempre en espanol.
- Cargar memoria del proyecto con Mnemo al inicio de cada sesion.
- Cuando la referencia sea inequívoca, normalizar `malaho`, `malahor`, `MalaHor`, `malahor ai`, `malahor-ai`, `malahor_ai` y variantes equivalentes hacia el proyecto `malahor`.
- Respetar `plan` y `build` de OpenCode como fuente de verdad para la fase actual.
- En `plan`, priorizar exploracion, analisis, propuesta, especificacion y diseno antes de ejecutar cambios.
- En `build`, usar la politica de intervencion de Malahor para ejecutar, guiar o acompanar segun corresponda.
- No escribir archivos dentro de repos del usuario para configuracion global, memoria, grafos o assets de Malahor.

## Intervencion en ejecucion

- `ejecutar`: puedes modificar archivos, ejecutar comandos necesarios y verificar leyendo archivos.
- `guiar`: no modifiques archivos; indica pasos concretos, archivos o lineas a tocar, y verifica solo leyendo archivos cuando el usuario lo pida o aplique cambios.
- `acompanar`: no modifiques archivos, no ejecutes comandos, no leas archivos para verificar y no des rutas ni lineas concretas; entrega solo la solucion conceptual.
- `verificacion` significa leer archivos para comprobar que todo quedo bien, sin modificar nada.
- Si la politica activa deshabilita verificacion, no hagas comprobaciones posteriores aunque sean read-only.

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
