---
description: Ejecuta el flujo de commit verificado de Malahor; nunca hace push
---

Ejecuta el flujo de commit verificado de Malahor.

Disparadores validos: el usuario dice "commit", "comitea" o equivalente explicito, o invoca `/malahor-commit`. No inicies este flujo por "continua", "listo", "cierra la fase" o una instruccion ambigua: no autorizan stage ni commit.

Reglas:

- La invocacion de este comando o un pedido explicito de commit autoriza el flujo y, solo si todo esta verde, el stage/commit de los archivos revisados. Nunca autoriza push.
- No uses `git add -A` por defecto: stagea solo los archivos del cambio revisado. Si hay archivos no relacionados o dudosos, pide confirmacion antes de stagear.
- No uses `--no-verify`, `--amend`, `git reset`, `git checkout`, `git revert` ni `git push`.
- OpenCode puede mostrar un ASK para `git add` o `git commit`: es el control de consentimiento verificable. No lo evites ni lo desactives.
- No inventes un build o un runner que el proyecto no tenga. Si no puedes verificar algo, detente y dilo.
- Si diagnostico, tests, build o precommit fallan, no commitees. Reporta el primer fallo con `archivo:linea`, causa y fix sugerido.

Pasos:

1. Revisa `git status --short`, `git diff --stat` y `git diff --cached --stat`. Si no hay cambios, detente.
2. Ejecuta el diagnostico: si existe el especialista `malahor-diagnostico`, delegale typecheck, lint y Sonar con el contexto del cambio; si no, ejecuta el typecheck/lint que corresponda al stack.
3. Ejecuta las pruebas: si existe `malahor-testing`, delegale las pruebas del area afectada; si no, usa el runner del stack. Despues ejecuta el build del proyecto.
4. Si todo esta verde, carga la skill `git-commit-text` y genera el subject con icono + Conventional Commit en espanol y el cuerpo en vinetas cuando aporte contexto.
5. Valida el mensaje y el cambio con `malahor-ai git precommit --message "<subject>"` (o el fallback `npx --yes malahor-ai git precommit --message "<subject>"`). Si el precommit falla o queda un ASK pendiente, detente; no lo fuerces.
6. Con el precommit en verde, stagea solo los archivos revisados y ejecuta `git commit -m "<subject>" -m "<cuerpo>"`. Si el mensaje tiene varias vinetas, conserva el cuerpo completo.
7. Verifica `git status --short` y `git log -1 --oneline`. Reporta el hash, los archivos incluidos y las validaciones ejecutadas. No hagas push.
