---
description: Recupera contexto Malahor compacto sin llenar la ventana
---

Recupera contexto del proyecto con el protocolo Malahor. Si el usuario escribio "recuperar contexto", tratalo igual que este comando.

Capsula local generada por Malahor:
!`malahor-ai context recover`

Foco opcional del usuario: $ARGUMENTS

Instrucciones:

1. Usa la capsula anterior como fuente inicial; no pegues memoria completa ni archivos completos.
2. Si falta memoria, consulta Mnemo con `mem_context` del proyecto canonico y limite bajo.
3. Si falta estructura tecnica, usa Graphify o busquedas dirigidas antes de leer archivos completos.
4. Si falta contexto de producto/PM y el nivel del proyecto incluye Obsidian, lee solo notas objetivo.
5. Devuelve una `Context Capsule` de maximo ~1500 tokens con: objetivo, estado, decisiones, archivos relevantes, siguiente paso y riesgos.
6. Continua con la tarea concreta si el siguiente paso es claro.
