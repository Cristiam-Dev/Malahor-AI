---
description: Instala, actualiza o repara Malahor desde el agente sin consola
---

Ejecuta el flujo bootstrap agent-safe de Malahor. Si el usuario escribio "instala malahor", "reinstala malahor" o "actualiza malahor", tratalo igual que este comando.

Capsula de ejecucion generada por Malahor:
!`malahor-ai install --bootstrap --yes 2>&1 || npx --yes malahor-ai install --bootstrap --yes 2>&1 || ( test -f package.json && grep -q 'malahor-ai' package.json && bun run src/cli/index.ts install --bootstrap --yes 2>&1 ) || echo 'MALAHOR_CLI_MISSING'`

Foco opcional del usuario: $ARGUMENTS

Instrucciones:

1. La capsula anterior ya corre con permisos del cliente: no depende de tus permisos de bash. No intentes reejecutarla si ya mostro exito.
2. Si la capsula muestra instalacion exitosa, corre `malahor-ai doctor` para confirmar y reporta en maximo 10 lineas: que se instalo, resultado del doctor y proximo paso.
3. Si la politica de intervencion cambio o se aplico por primera vez, avisa al usuario que abra una sesion nueva de OpenCode para recargar permisiones.
4. Si la capsula muestra `MALAHOR_CLI_MISSING`, instala el CLI tu mismo con tus herramientas (`npm install -g malahor-ai` o `bun add -g malahor-ai`) y vuelve a ejecutar el bootstrap. Si tus permisos tampoco lo permiten, entrega UNA sola linea copia-y-pega al usuario; nunca des instrucciones de terminales intermedios ni ediciones manuales de configuracion.
5. No instales proveedores opcionales de contexto de codigo durante este flujo.
6. No edites `opencode.jsonc` a mano; todas las reparaciones pasan por el CLI.
