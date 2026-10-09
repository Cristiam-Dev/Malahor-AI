# programming/quality/tdd

## Usar Cuando

- Bug fixes, reglas de negocio, algoritmos o cambios con criterios de aceptacion claros.

## Versiones y compatibilidad

- TDD es practica, no herramienta. Funciona con cualquier stack si el comportamiento se puede observar.
- No forzar TDD cuando el problema aun es exploratorio o de UI visual incierta.

## Reglas canonicas sintetizadas

- Red: escribir un test que falle por la razon correcta.
- Green: cambio minimo para pasar.
- Refactor: mejorar diseño manteniendo tests verdes.
- Empezar por comportamiento externo y casos de dominio, no por metodos privados.
- En bugs, primero capturar regresion reproducible.

## Anti-patrones

- Tests despues llamados TDD.
- Mockear internals para poder escribir el test.
- Ciclos grandes que mezclan muchas responsabilidades.

## Validacion

- Mostrar o registrar el test rojo/verde cuando el flujo lo permita.
- Mantener suite rapida para ciclos de feedback.

## Fuentes canonicas

- Kent Beck, Test Driven Development: https://www.oreilly.com/library/view/test-driven-development/0321146530/
- Martin Fowler, Is TDD dead?: https://martinfowler.com/articles/is-tdd-dead/
