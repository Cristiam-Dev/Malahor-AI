# programming/quality/clean-code

## Usar Cuando

- Refactor, limpieza, mantenibilidad o revision de codigo generado por IA.

## Versiones y compatibilidad

- Principios generales; adaptar al lenguaje, framework y convenciones existentes.
- No hacer refactor amplio sin tests o sin alcance explicito.

## Reglas profesionales

- Nombres expresan intencion de dominio, no implementacion accidental.
- Funciones pequenas con una responsabilidad observable.
- Evitar estados imposibles: tipos, validaciones y invariantes claras.
- Comentarios explican decisiones/no-obvio, no repiten codigo.
- Duplicacion: extraer cuando hay patron estable, no en la primera coincidencia accidental.
- Errores explicitos y mensajes accionables.
- Codigo generado por IA debe pasar el mismo estandar que codigo humano.

## Anti-patrones

- Abstraccion prematura.
- Refactor cosmetico que mezcla cambios funcionales.
- Helpers genericos sin dueño.
- Comentarios obsoletos o ruido.

## Validacion

- Tests existentes verdes.
- Diff separa refactor de comportamiento cuando sea posible.
- Complejidad y nombres mejoran sin ocultar reglas.

## Fuentes canonicas

- Refactoring, Martin Fowler: https://martinfowler.com/books/refactoring.html
- Google Engineering Practices: https://google.github.io/eng-practices/
- Clean Code, Robert C. Martin: https://www.oreilly.com/library/view/clean-code-a/9780136083238/
