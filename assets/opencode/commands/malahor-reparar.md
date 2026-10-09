---
description: Repara Malahor y desbloquea al agente sin consola
---

Ejecuta la autorreparacion segura de Malahor. Si el usuario escribio "repara malahor", "estoy bloqueado" o "el agente no puede editar", tratalo igual que este comando.

Capsula de ejecucion generada por Malahor:
!`malahor-ai doctor --self-heal 2>&1 || npx --yes malahor-ai doctor --self-heal 2>&1 || echo 'MALAHOR_CLI_MISSING'`

Foco opcional del usuario: $ARGUMENTS

Instrucciones:

1. La capsula corre con permisos del cliente: puede reparar permisos del agente incluso si tu bash esta bloqueado.
2. Resume el bloque `Reparado:` en lenguaje simple: que se arregto y que falta.
3. Si se migraron permisos legacy o cambio la politica, pide al usuario abrir una sesion nueva de OpenCode (o cambiar de agente con Tab) para recargar permisiones; solo entonces el agente recuperara herramientas.
4. Si algo sigue FAIL y el self-heal no alcanza, ejecuta el flujo `/malahor-bootstrap` para reinstalar con validacion.
5. Si queda `MALAHOR_CLI_MISSING`, instala el CLI con tus herramientas si puedes; si no, entrega UNA sola linea copia-y-pega, sin clases de terminales.
6. Nunca digas al usuario que edite `opencode.jsonc` a mano: el CLI lo migrar por el.
