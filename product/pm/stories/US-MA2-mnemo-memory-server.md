# US-MA2 - Guardar y recuperar memoria persistente con Mnemo

## Historia

Como desarrollador asistido por IA, quiero que Malahor recuerde decisiones, bugs, patrones y resumenes de sesion para no repetir contexto en cada conversacion.

## Criterios de aceptacion

- Mnemo expone herramientas MCP por stdio.
- `mem_save` guarda observaciones por proyecto.
- `mem_search` busca por query, proyecto, tipo y limite.
- `mem_context` retorna contexto reciente del proyecto.
- `mem_session_summary` guarda resumenes de cierre.
- Mnemo rechaza contenido sensible antes de guardarlo.
- La memoria persiste en JSON local sin dependencias nativas.

## Estado

Pendiente.
