---
description: Actualiza una instalacion existente de Malahor y valida su salud
---

Ejecuta el rollout local gestionado de Malahor. Si el usuario escribio "actualiza malahor", tratalo igual que este comando.

Capsula de ejecucion generada por Malahor:
!`if command -v malahor-ai >/dev/null 2>&1; then malahor-ai update --yes 2>&1 && malahor-ai doctor 2>&1; elif test -f package.json && grep -q '"name"[[:space:]]*:[[:space:]]*"malahor-ai"' package.json && test -f dist/index.js; then node dist/index.js update --yes 2>&1 && node dist/index.js doctor 2>&1; elif test -f package.json && grep -q '"name"[[:space:]]*:[[:space:]]*"malahor-ai"' package.json && test -f src/cli/index.ts && command -v bun >/dev/null 2>&1; then bun run src/cli/index.ts update --yes 2>&1 && bun run src/cli/index.ts doctor 2>&1; else echo 'MALAHOR_CLI_MISSING'; fi`

Foco opcional del usuario: $ARGUMENTS

Instrucciones:

1. La capsula actualiza una instalacion existente y solo ejecuta `doctor` si el update termina correctamente; no la reejecutes si ya mostro exito.
2. Si la actualizacion termino con exito, resume el resultado de `malahor-ai doctor` en maximo 10 lineas: que se actualizo, estado final y proximo paso.
3. Si aparece `MALAHOR_CLI_MISSING`, usa `/malahor-bootstrap`; no conviertas una actualizacion fallida en install.
4. Si falla el update, informa el error original y detente. No uses `npx`, no instales dependencias y no reintentes con bootstrap.
5. Si cambiaron assets o capacidades, sigue el resultado de `doctor` y usa `/reload` solo si lo indica.
6. No edites `opencode.jsonc` ni otros archivos de configuracion a mano.
