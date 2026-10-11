# git

Guia base para trabajar con Git dentro de Malahor.

## Regla Principal

No ejecutar `git add`, `git commit`, `git amend`, `git push`, `git reset`, `git checkout` ni operaciones equivalentes que modifiquen el estado del repositorio salvo orden explicita del usuario.

## Regla De Oro Para Mensajes De Commit

Al proponer texto de commit, cargar y aplicar siempre `git-commit-text`. El formato canonico es icono + Conventional Commit en espanol, con cuerpo en viñetas siempre que sea viable y aporte contexto. Omitir cuerpo solo si el cambio es trivial.

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
- Push.
- Force push.
- Revertir cambios.
- Borrar ramas.

## Skills Relacionados

- `git-status-review`
- `git-commit-text`
- `git-pr-review`
- `git-safety`
