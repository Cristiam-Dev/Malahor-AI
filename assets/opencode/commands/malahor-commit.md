---
description: Ejecuta el flujo de commit verificado de Malahor; nunca hace push
---

<!-- malahor-commit-request:v1 -->

Ejecuta el flujo de commit verificado de Malahor.

Disparadores validos: el usuario dice "commit", "comitea" o equivalente explicito, o invoca `/malahor-commit`. No inicies este flujo por "continua", "listo", "cierra la fase" o una instruccion ambigua: no autorizan stage ni commit.

Reglas:

- La invocacion de este comando o un pedido explicito de commit habilita preparar el manifest, pero no es el grant ejecutable. No presentes `malahor_plan`, no invoques `malahor_run` ni esperes `go`: `malahor_commit_prepare` solicitará una única aprobación nativa de la UI para el manifest exacto.
- Carga exclusivamente `git-commit-text`. Si no esta disponible, detente y reporta el catalogo incompleto: no uses otra skill como fallback. Genera y valida el subject con `malahor-ai git commit-message "<resumen>" --type <tipo> --scope <scope> [--breaking] --json`; este preflight es read-only y no autoriza por si solo stage ni commit.
- Tras las inspecciones read-only, determina las rutas y los comandos literales de diagnostico, pruebas, build, stage, precommit, commit y revalidacion. Valida ese manifest con `malahor_commit_prepare` y deja que la UI pida su aprobación exacta antes de ejecutar los gates.
- Si `malahor_commit_prepare` o la aprobación nativa no están disponibles, o el manifest se rechaza, detente y reporta que el runtime requiere actualización, recarga o una nueva orden explícita. No uses un plan, token o diálogo manual como fallback.
- Tras la aprobación nativa, ejecuta todo el grant en una sola pasada y, solo si está verde, el stage exacto y un commit ordinario local de los archivos revisados.
- No uses `git add -A` por defecto: stagea solo los archivos del cambio revisado. Si hay archivos no relacionados o dudosos, pide confirmacion antes de stagear.
- Esta orden no autoriza `--amend`, reset, rebase, cherry-pick, merge ni operaciones de ramas; cada una requiere su propio pedido. No uses `--no-verify`.
- Git remoto es hard DENY: nunca ejecutes push, pull, fetch, clone, `ls-remote`, `remote update`, submodulos remotos ni equivalentes, aunque la persona los pida o apruebe.
- Propaga el pedido ya recibido como `intent: "commit"` a los hooks de stage y commit; es evidencia estructurada interna, no un token ni una nueva pregunta al usuario.
- No inventes un build o un runner que el proyecto no tenga. Si no puedes verificar algo, detente y dilo.
- Si diagnostico, tests, build o precommit fallan, no commitees. Reporta el primer fallo con `archivo:linea`, causa y fix sugerido.
- El fallback externo solo aplica si precommit quedo verde, staged/huella siguen exactos y el intento real de commit fue bloqueado por el host o harness. Nunca lo ofrezcas para un DENY/ASK de contenido o politica.

Pasos:

1. Revisa `git status --short`, `git diff --stat` y `git diff --cached --stat`. Si no hay cambios, detente.
2. Conserva el subject prevalidado con `git-commit-text`, genera el cuerpo en viñetas cuando aporte contexto y determina rutas y comandos exactos. Invoca `malahor_commit_prepare` y espera la aprobación nativa que muestra la UI; si el diff, scope, cwd, path, subject o comando cambia después, el grant queda inválido y hace falta una nueva orden explícita.
3. Ejecuta directamente el diagnostico disponible del stack: typecheck, lint y Sonar local cuando existan. No delegues este flujo de commit.
4. Ejecuta directamente las pruebas y despues el build del proyecto.
5. Ejecuta `malahor_hook_check` para `file.stage.before` con el comando `git add -- <rutas exactas>`, esas mismas rutas e `intent: "commit"`. Si no permite, detente. Luego stagea exclusivamente esas rutas.
6. Valida el staged y el subject con `malahor-ai git precommit --message "<subject>" --json`. Conserva `targetPaths` y `stagedFingerprint`; si falla o queda un ASK pendiente, detente y no uses fallback.
7. Ejecuta `malahor_hook_check` para `git.commit.before` con el comando final, las rutas staged e `intent: "commit"`. Si permite, ejecuta `git commit -m "<subject>" -m "<cuerpo>"` sin `--no-verify`.
8. Solo si el host/harness bloquea esa ejecucion ya autorizada, ejecuta `malahor-ai git commit-fallback --message "<subject>" --body "<cuerpo>" --paths '["ruta/uno.ts","ruta/con,coma.ts"]' --fingerprint "<stagedFingerprint>" --blocked-by host-deny|host-ask|harness-unavailable`. `--paths` es el array JSON exacto de `targetPaths`; no lo construyas separando por comas. Declara que no ejecutaste el commit y entrega el comando POSIX o PowerShell exacto devuelto; no improvises otro.
9. Tras el commit del agente o la ejecucion humana, verifica `git status --short --untracked-files=all` y `git --no-pager log -1 --oneline`. Reporta hash, archivos y validaciones. Nunca contactes un remoto.
