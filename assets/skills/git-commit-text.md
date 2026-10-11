# git-commit-text

Skill canonica de Malahor para proponer texto de commit. Es regla de oro: siempre que el usuario pida un commit message, texto de commit, cierre de fase con commit o equivalente, aplicar esta skill antes de responder.

## Regla De Oro

1. Generar texto de commit; no ejecutar `git add`, `git commit`, `commit --amend` ni `push` salvo orden explicita y especifica del usuario.
2. Usar subject con icono inicial + Conventional Commit en espanol.
3. Incluir cuerpo con viñetas siempre que sea viable y aporte contexto, razon, impacto, docs o validaciones.
4. Omitir cuerpo solo si el cambio es trivial y el cuerpo no aporta informacion real.
5. Nunca agregar atribucion de IA, firmas, co-authored-by ni ruido ceremonial.

## Formato Canonico

```txt
icono tipo(scope): resumen imperativo breve

- cambio principal realizado
- razon o impacto cuando aporte
- docs/tests/validaciones relevantes cuando existan
```

## Preferencias Del Usuario

- Responder en espanol.
- Agregar un icono referente al inicio del titulo.
- Mantener Conventional Commits despues del icono.
- Usar cuerpo con lista de viñetas `-` por defecto cuando el cambio tenga sustancia.
- Una idea por viñeta; sin parrafos largos.
- Subject conciso; el detalle va en el cuerpo.
- Si hay cambios en docs/openapi/postman en backend, mencionarlos en el cuerpo del commit.

## Tipos E Iconos Sugeridos

- ✨ `feat`: nueva capacidad.
- 🐛 `fix`: correccion de bug.
- 📝 `docs`: documentacion.
- ✅ `test`: pruebas.
- ♻️ `refactor`: refactor interno.
- 🎨 `style`: formato/estilo sin cambio funcional.
- 🔧 `chore`: mantenimiento.
- 📦 `build`: build, empaquetado o dependencias.
- 👷 `ci`: integracion continua.
- 🔒 `security`: seguridad.
- ⚡ `perf`: rendimiento.
- ⏪ `revert`: revert.

## Como Elegir Scope

- Preferir scope de dominio o modulo: `hooks`, `mnemo`, `cli`, `opencode`, `docs`, `tests`.
- Evitar scopes genericos si existe uno mas preciso.
- Usar kebab-case: `hook-policy`, `git-workflow`.

## Cuerpo Del Commit

Incluir cuerpo cuando haya al menos uno de estos elementos:

- mas de un archivo o modulo tocado;
- cambio de comportamiento;
- guardrail, seguridad, permisos o politica;
- docs o instrucciones actualizadas;
- tests, build, smokes o validaciones relevantes;
- razon del cambio no obvia por el subject.

Omitir cuerpo solo para cambios triviales como typo, version menor o ajuste mecanico obvio.

## Salida

- Entregar solo el bloque del commit, salvo que el usuario pida explicacion.
- Usar fenced block `txt` cuando sea conversacion normal.
- Si el usuario pide solo el titulo, entregar solo el subject.
- Si hay incertidumbre de scope/tipo, elegir el mas probable y no bloquear con preguntas salvo riesgo real.
