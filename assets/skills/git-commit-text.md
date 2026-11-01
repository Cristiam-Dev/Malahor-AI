# git-commit-text

Skill canonica de Malahor para generar texto de commit con el mismo contrato Unicode que valida el guard de Git.

## Autoridad y disponibilidad

1. Cargar esta skill siempre que la persona pida un mensaje, titulo o ejecucion de commit.
2. No usar otra skill de commits como fallback. Si esta skill no esta disponible en el catalogo anunciado por OpenCode, detenerse y reportar que la instalacion esta incompleta.
3. Esta skill orienta el texto; no autoriza `git add`, `git commit`, amend, push ni ninguna otra mutacion Git.
4. Prevalidar el subject con `malahor-ai git commit-message ... --json` antes de firmar el plan de commit. Ese subcomando es read-only.

## Subject canonico

```txt
<emoji> <tipo>[(<scope>)][!]: <resumen imperativo breve en espanol>
```

- El icono es un unico grafema emoji Unicode. Se admiten selectores de variacion y secuencias compuestas, por ejemplo `🛡️` y `♻️`.
- Tipos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `security`.
- El scope es opcional, usa letras o numeros Unicode y guiones: `hooks`, `git-workflow`, `núcleo-ágil`.
- Un breaking change usa `tipo!:` o `tipo(scope)!:`. Añadir tambien un footer `BREAKING CHANGE:` cuando el cuerpo deba explicar la incompatibilidad.
- El resumen no queda vacio, no contiene saltos de linea y el subject completo respeta el limite aplicado por la CLI.

## Iconos sugeridos

- ✨ `feat`: nueva capacidad.
- 🐛 `fix`: correccion de bug.
- 📝 `docs`: documentacion.
- 🎨 `style`: formato sin cambio funcional.
- ♻️ `refactor`: refactor interno.
- ⚡ `perf`: rendimiento.
- ✅ `test`: pruebas.
- 📦 `build`: build, empaquetado o dependencias.
- 👷 `ci`: integracion continua.
- 🔧 `chore`: mantenimiento.
- ⏪ `revert`: revert.
- 🛡️ `security`: seguridad.

## Cuerpo

Usar cuerpo con viñetas cuando haya cambio de comportamiento, mas de un archivo o modulo, guardrails, seguridad, permisos, documentacion, pruebas, build o una razon no obvia.

```txt
🛡️ security(hooks): protege validacion Unicode

- comparte el contrato entre generador y guard
- admite emojis compuestos y scopes Unicode
- valida el flujo con pruebas enfocadas
```

Omitir el cuerpo solo cuando el cambio sea trivial y no aporte informacion real. No agregar atribucion de IA, firmas, `Co-authored-by` ni ruido ceremonial.

## Preflight read-only

```sh
malahor-ai git commit-message "protege sesion y envio" --type security --scope "núcleo-seguro" --icon "🛡️" --json
malahor-ai git commit-message "cambia el contrato publico" --type feat --scope api --breaking --json
```

Si la CLI rechaza el subject, corregir tipo, scope, icono o resumen antes del plan. Nunca relajar el hook ni sustituir la skill canonica.

## Salida conversacional

- Entregar solo el bloque del commit salvo que la persona pida explicacion.
- Usar un bloque `txt` en conversacion normal.
- Si pide solo el titulo, entregar solo el subject.
- Elegir el tipo y scope mas probables sin bloquear con preguntas salvo riesgo real.
