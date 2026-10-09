# programming/frontend/typescript

## Usar Cuando

- TypeScript en frontend/backend, contratos compartidos, librerias o configuracion tipada.

## Versiones y compatibilidad

- Baseline 2026-10: TypeScript moderno; validar version en `package.json`/lockfile.
- `strict` es objetivo profesional, pero migraciones legacy deben ser graduales y medibles.

## Reglas oficiales sintetizadas

- Modelar datos con tipos explicitos en boundaries: API, env, storage, config, CLI args y URL params.
- Preferir narrowing y discriminated unions para estados/errores mutuamente excluyentes.
- Evitar `any`; si es inevitable, aislarlo en borde y validar runtime.
- Usar generics cuando mejoran el contrato de consumo, no para impresionar.
- Separar tipos externos (DTO/API) de modelos internos si cambian por razones distintas.
- Mantener `tsconfig` coherente: `strict`, `noImplicitAny`, resolucion de modulos alineada al runtime/bundler.
- Validar runtime con schemas o funciones cuando el dato viene de fuera del proceso.

## Anti-patrones

- `as unknown as` para silenciar errores.
- Tipos duplicados sin fuente clara.
- Interfaces genericas (`Data`, `Item`, `Payload`) sin significado de dominio.
- Casts en cadena despues de parsear JSON sin validacion.

## Validacion

- `tsc --noEmit`.
- Tests de parsers/validators de boundaries.
- Revisar que tipos publicos exportados no filtren detalles internos.

## Referencias oficiales

- TypeScript Docs: https://www.typescriptlang.org/docs/
- Handbook: https://www.typescriptlang.org/docs/handbook/intro.html
- Narrowing: https://www.typescriptlang.org/docs/handbook/2/narrowing.html
- TSConfig: https://www.typescriptlang.org/tsconfig/
