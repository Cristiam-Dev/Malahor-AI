# git-commit-text

Generar texto de commit sin ejecutar el commit.

## Regla

Entregar solo el texto sugerido. No ejecutar `git add` ni `git commit` salvo orden explicita.

## Formato Base

Usar Conventional Commits en espanol:

```txt
tipo(scope): resumen imperativo

Cuerpo opcional cuando aporte contexto, razon o impacto.
```

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
- Cuerpo en espanol si el cambio no es trivial.
