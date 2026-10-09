# programming/architecture/design-patterns

## Usar Cuando

- Hay varias formas razonables de resolver un problema de diseño y se necesita elegir un patron.

## Versiones y compatibilidad

- Patrones son vocabulario de diseño; adaptar a lenguaje/paradigma.
- La solucion directa es el default cuando no hay variacion real.

## Reglas profesionales

- Strategy para variaciones reales de comportamiento seleccionables.
- Adapter para aislar APIs externas o librerias.
- Factory cuando construir objetos tiene reglas o variantes.
- Repository cuando persistencia necesita boundary estable o queries complejas.
- Facade para simplificar subsistemas complejos.
- Observer/Event cuando hay hechos y multiples consumidores desacoplados.
- Decorator/Middleware para comportamiento composable sin herencia pesada.

## Anti-patrones

- Patrones por anticipacion.
- Factories para constructores triviales.
- Abstracciones que ocultan reglas en vez de aclararlas.
- Singletons para estado global mutable.

## Validacion

- Explicar problema, alternativa simple, patron elegido, costo y prueba.
- Confirmar que reduce acoplamiento o duplicacion real.

## Fuentes canonicas

- Design Patterns, Gamma/Helm/Johnson/Vlissides: https://wiki.c2.com/?DesignPatternsBook
- Refactoring Guru catalog: https://refactoring.guru/design-patterns
- Martin Fowler, Patterns of Enterprise Application Architecture: https://martinfowler.com/books/eaa.html
