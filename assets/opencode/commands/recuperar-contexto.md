---
description: Recupera contexto Malahor compacto sin llenar la ventana
---

Recupera contexto del proyecto con el protocolo Malahor. Si el usuario escribio "recuperar contexto", tratalo igual que este comando.

Capsula local generada por Malahor:
!`malahor-ai context recover`

Foco opcional del usuario: $ARGUMENTS

Instrucciones:

1. Usa la capsula anterior como fuente inicial; no pegues memoria completa ni archivos completos.
2. `mem_context` ya hereda automaticamente memorias del scope, sus padres y `global`.
3. Si el foco menciona una asignacion, modulo o trabajo previo que se quiera reutilizar, llama `mem_brief` con el foco en lenguaje natural, el proyecto del workspace y el scope que infieras; no pidas al usuario una clave tecnica.
4. Si Mnemo devuelve varias scopes igualmente plausibles, pregunta una sola vez; trata las memorias de otros scopes como referencias, sin duplicarlas ni moverlas.
5. Si falta estructura tecnica, usa la capacidad de contexto de codigo configurada o busquedas dirigidas antes de leer archivos completos.
6. Si falta contexto de producto/PM y el nivel del proyecto incluye Obsidian, lee solo notas objetivo.
7. Devuelve una `Context Capsule` de maximo ~1500 tokens con: objetivo, estado, decisiones, archivos relevantes, siguiente paso y riesgos.
8. Continua con la tarea concreta si el siguiente paso es claro.
