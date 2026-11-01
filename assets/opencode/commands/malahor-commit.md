---
description: Ejecuta el flujo de commit verificado de Malahor; nunca hace push
---

Ejecuta el flujo de commit verificado de Malahor.

Disparadores validos: el usuario dice "commit", "comitea" o equivalente explicito, o invoca `/malahor-commit`. No inicies este flujo por "continua", "listo", "cierra la fase" o una instruccion ambigua: no autorizan stage ni commit.

Reglas:

- La invocacion de este comando o un pedido explicito de commit crea un plan nivel 0 minimo. Presentalo y espera `go`; no uses Discovery, SDD, subagentes ni documentacion ceremonial.
- Tras `go`, ejecuta todo el flujo en una sola pasada y, solo si esta verde, el stage exacto y un commit ordinario local de los archivos revisados. No pidas otra confirmacion humana.
- No uses `git add -A` por defecto: stagea solo los archivos del cambio revisado. Si hay archivos no relacionados o dudosos, pide confirmacion antes de stagear.
- Esta orden no autoriza `--amend`, reset, rebase, cherry-pick, merge ni operaciones de ramas; cada una requiere su propio pedido. No uses `--no-verify`.
- Git remoto es hard DENY: nunca ejecutes push, pull, fetch, clone, `ls-remote`, `remote update`, submodulos remotos ni equivalentes, aunque la persona los pida o apruebe.
- Propaga el pedido ya recibido como `intent: "commit"` a los hooks de stage y commit; es evidencia estructurada interna, no un token ni una nueva pregunta al usuario.
- No inventes un build o un runner que el proyecto no tenga. Si no puedes verificar algo, detente y dilo.
- Si diagnostico, tests, build o precommit fallan, no commitees. Reporta el primer fallo con `archivo:linea`, causa y fix sugerido.
- El fallback externo solo aplica si precommit quedo verde, staged/huella siguen exactos y el intento real de commit fue bloqueado por el host o harness. Nunca lo ofrezcas para un DENY/ASK de contenido o politica.

Pasos:

1. Revisa `git status --short`, `git diff --stat` y `git diff --cached --stat`. Si no hay cambios, detente.
2. Ejecuta directamente el diagnostico disponible del stack: typecheck, lint y Sonar cuando existan. No delegues un commit nivel 0 salvo que el alcance deje de ser trivial y requiera un plan revisado.
3. Ejecuta directamente las pruebas y despues el build del proyecto.
4. Si todo esta verde, carga `git-commit-text` y genera el subject con icono + Conventional Commit en espanol y el cuerpo en vinetas cuando aporte contexto.
5. Ejecuta `malahor_hook_check` para `file.stage.before` con el comando `git add -- <rutas exactas>`, esas mismas rutas e `intent: "commit"`. Si no permite, detente. Luego stagea exclusivamente esas rutas.
6. Valida el staged y el subject con `malahor-ai git precommit --message "<subject>" --json`. Conserva `targetPaths` y `stagedFingerprint`; si falla o queda un ASK pendiente, detente y no uses fallback.
7. Ejecuta `malahor_hook_check` para `git.commit.before` con el comando final, las rutas staged e `intent: "commit"`. Si permite, ejecuta `git commit -m "<subject>" -m "<cuerpo>"` sin `--no-verify`.
8. Solo si el host/harness bloquea esa ejecucion ya autorizada, ejecuta `malahor-ai git commit-fallback --message "<subject>" --body "<cuerpo>" --paths '["ruta/uno.ts","ruta/con,coma.ts"]' --fingerprint "<stagedFingerprint>" --blocked-by host-deny|host-ask|harness-unavailable`. `--paths` es el array JSON exacto de `targetPaths`; no lo construyas separando por comas. Declara que no ejecutaste el commit y entrega el comando POSIX o PowerShell exacto devuelto; no improvises otro.
9. Tras el commit del agente o la ejecucion humana, verifica `git status --short --untracked-files=all` y `git --no-pager log -1 --oneline`. Reporta hash, archivos y validaciones. Nunca contactes un remoto.
