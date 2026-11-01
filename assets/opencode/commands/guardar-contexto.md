---
description: Guarda checkpoint de sesion antes de cambiar, pausar o compactar
---

Guarda contexto persistente Malahor para poder continuar despues sin perder estado.

Foco opcional del usuario: $ARGUMENTS

Instrucciones:

1. Resume la sesion actual en formato compacto: objetivo, requisitos, decisiones, completado, activo, bloqueos, archivos relevantes, validaciones y proximo paso exacto.
2. Guarda el resumen con Mnemo `mem_session_summary` en el scope activo de la tarea; si no se definio uno, usa el proyecto canonico.
3. Si hay una decision tecnica estable, bug o patron reusable, guarda tambien una observacion `mem_save` en ese mismo scope y con tipo adecuado.
4. Si el cambio afecta PM/manual/documentacion persistente, resuelve la raiz canonica y actualiza solo el Markdown necesario mediante `docs_read` + `docs_write`/`docs_append` con version. Nunca uses filesystem, Obsidian MCP ni fallback al repo.
5. Interpreta el foco en lenguaje natural: no pidas al usuario clave canonica, path interno, SHA ni nombre de tool si puedes inferirlos; busca antes de crear duplicados.
6. Responde con el id o confirmacion de memoria y un resumen de 5 bullets maximo.

No llenes la ventana con detalles historicos; guarda el detalle en memoria y muestra solo la confirmacion.
