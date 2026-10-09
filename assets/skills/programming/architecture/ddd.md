# programming/architecture/ddd

## Usar Cuando

- Dominio complejo con reglas, invariantes, lenguaje ubicuo o multiples bounded contexts.

## Versiones y compatibilidad

- DDD es estrategia de modelado, no stack tecnico.
- Evitar DDD pesado en CRUD simple; aplicar tacticas parciales cuando aportan claridad.

## Reglas canonicas sintetizadas

- Modelar lenguaje del negocio antes que tablas o endpoints.
- Bounded contexts delimitan vocabulario, modelo y ownership.
- Aggregates protegen invariantes transaccionales; no exponer mutaciones libres.
- Value Objects para conceptos con reglas e igualdad por valor.
- Domain Events representan hechos de negocio ya ocurridos.
- Repositories abstraen colecciones de aggregates cuando hay dominio rico.

## Anti-patrones

- Entidades anemicas con todo comportamiento en services genericos.
- Aggregates enormes por comodidad de carga.
- Eventos usados como comandos sincronicos disfrazados.
- Lenguaje tecnico reemplazando lenguaje de negocio.

## Validacion

- Revisar invariantes con ejemplos del negocio.
- Confirmar boundaries y transacciones por aggregate.
- Validar nombres con usuarios/dominio cuando sea posible.

## Fuentes canonicas

- Eric Evans, Domain-Driven Design: https://www.domainlanguage.com/ddd/
- Martin Fowler, Domain-Driven Design: https://martinfowler.com/tags/domain%20driven%20design.html
- Vaughn Vernon, Implementing Domain-Driven Design: https://www.informit.com/store/implementing-domain-driven-design-9780321834577
