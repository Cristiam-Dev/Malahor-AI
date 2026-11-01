---
description: Diagnostica la instalacion de Malahor sin usar bash del agente
---

Ejecuta el diagnostico de Malahor e interpreta el reporte OK/WARN/FAIL.

Capsula de ejecucion generada por Malahor:
!`malahor-ai doctor 2>&1 || npx --yes malahor-ai doctor 2>&1 || echo 'MALAHOR_CLI_MISSING'`

Foco opcional del usuario: $ARGUMENTS

Instrucciones:

1. La capsula anterior corre con permisos del cliente, aunque tu bash este restringido.
2. Explica en lenguaje simple (maximo 12 lineas) que esta OK, que es WARN opcional y que es FAIL real.
3. Por cada FAIL, indica el flujo adecuado: `malahor-ai doctor --self-heal` o `/malahor-reparar` para reparar; `/malahor-actualizar` si la instalacion existe pero quedo desactualizada.
4. Si aparece `MALAHOR_CLI_MISSING` o la instalacion esta ausente, usa `/malahor-bootstrap`.
5. No edites `opencode.jsonc` a mano y no pidas al usuario que abra una consola.
