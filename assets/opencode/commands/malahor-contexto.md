---
description: Muestra el contexto resuelto del proyecto y el estado de Malahor
---

Muestra el contexto operativo resuelto para este proyecto. Si el usuario escribio "contexto", "estado del proyecto" o "donde estoy", tratalo igual que este comando.

Capsula local generada por Malahor:
!`malahor-ai context status 2>&1 || npx --yes malahor-ai context status 2>&1 || echo 'MALAHOR_CLI_MISSING'`

Foco opcional del usuario: $ARGUMENTS

Instrucciones:

1. La capsula anterior corre con permisos del cliente; no la reejecutes si ya mostro datos.
2. Resume en maximo 10 lineas: proyecto canonico, root activo, nivel de contexto, memoria, proveedor de contexto de codigo, Obsidian y estado del puente.
3. Si el usuario pide recuperar contexto o memoria, usa `/recuperar-contexto` o `malahor-ai context recover`; no dupliques la capsula completa.
4. Si el proyecto o el root es ambiguo o no esta registrado, pide una sola aclaracion antes de operar; no asumas el cwd.
5. Si aparece `MALAHOR_CLI_MISSING`, indica `/malahor-bootstrap`; no edites `opencode.jsonc` a mano.
6. No leas archivos completos ni memoria completa para responder esto.
