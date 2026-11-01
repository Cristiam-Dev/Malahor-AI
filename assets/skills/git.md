# git

Guia base para trabajar con Git dentro de Malahor.

## Regla Principal

Esta skill solo refleja la politica del programa; no la define ni puede rebajarla.

- Git remoto/red (`push`, `pull`, `fetch`, `clone` y equivalentes) es hard DENY sin excepciones.
- Las operaciones locales que mutan Git requieren una orden explicita y especifica.
- `comitea` autoriza, tras gates verdes, stage exacto revisado y commit ordinario local; no autoriza amend/reset/rebase/cherry-pick/merge/ramas.
- Las operaciones locales destructivas requieren preview, target visible y aprobacion propia.

## Regla De Oro Para Mensajes De Commit

Al proponer texto de commit, cargar y aplicar siempre `git-commit-text`; si no esta disponible, detenerse y reportar el catalogo incompleto, sin usar otra skill como fallback. Prevalidar el subject con `malahor-ai git commit-message`, que es read-only. El formato canonico es un grafema emoji Unicode + Conventional Commit en espanol, con `!` opcional para breaking changes y cuerpo en viñetas cuando aporte contexto.

## Permitido En Modo Assistant

- Revisar `git status`.
- Revisar `git diff`.
- Revisar `git log`.
- Proponer texto de commit.
- Proponer plan de staging.
- Detectar riesgos antes de commit o PR.

## No Permitido Sin Orden Explicita

- Stagear archivos.
- Crear commits.
- Amend.
- Reset, rebase, cherry-pick, merge y operaciones de ramas.
- Revertir cambios.
- Borrar ramas.

## Nunca Permitido

- Push o force push.
- Pull, fetch o clone.
- `ls-remote`, `remote update`, submodulos remotos o equivalentes de red.

## Skills Relacionados

- `git-status-review`
- `git-commit-text`
- `git-pr-review`
- `git-safety`
