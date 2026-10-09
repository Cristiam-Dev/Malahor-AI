# git-commit-text

Generar texto de commit sin ejecutar el commit.

## Regla

Entregar solo el texto sugerido. No ejecutar `git add` ni `git commit` salvo orden explicita.

## Formato Base

Usar Conventional Commits en espanol:

```txt
icono tipo(scope): resumen imperativo

- Punto principal con viñeta.
- Otro punto relevante si aporta contexto, razon o impacto.
```

## Preferencia Del Usuario

- Agregar un icono referente al inicio del titulo del commit.
- Dividir el cuerpo en puntos tipo lista con viñetas `-`.
- Mantener el texto en espanol.
- Mantener Conventional Commits despues del icono.
- No usar cuerpo si el commit es trivial; si hay cuerpo, usar solo viñetas.

## Iconos Sugeridos

- ✨ `feat`: nueva capacidad.
- 🐛 `fix`: correccion de bug.
- 📝 `docs`: documentacion.
- ✅ `test`: pruebas.
- ♻️ `refactor`: refactor interno.
- 🔧 `chore`: mantenimiento.
- 📦 `build`: build, empaquetado o dependencias.
- 👷 `ci`: integracion continua.
- 🔒 `security`: seguridad.
- ⚡ `perf`: rendimiento.

## Tipos

- `feat`: nueva capacidad.
- `fix`: correccion de bug o comportamiento incorrecto.
- `docs`: documentacion.
- `test`: pruebas.
- `refactor`: cambio interno sin alterar comportamiento.
- `chore`: mantenimiento.
- `build`: build, empaquetado o dependencias.
- `ci`: integracion continua.

## Salida

- Seccion `Texto Del Commit`.
- Bloque fenced `txt`.
- Titulo con icono inicial referente al tipo/cambio.
- Cuerpo en espanol si el cambio no es trivial.
- Cuerpo dividido en viñetas, una idea por linea.
