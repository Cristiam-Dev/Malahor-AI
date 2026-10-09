# programming/architecture/clean-architecture

## Usar Cuando

- Se requieren boundaries claros entre dominio, aplicacion, interfaz e infraestructura.
- El sistema tendra vida larga, multiples adaptadores o reglas de negocio relevantes.

## Versiones y compatibilidad

- Principio arquitectonico independiente de lenguaje/framework.
- No aplicar como capas ceremoniales si el sistema es CRUD simple o prototipo temporal.

## Reglas canonicas sintetizadas

- Dependencias apuntan hacia politicas internas: dominio/casos de uso no conocen detalles externos.
- Casos de uso representan intenciones de negocio, no acciones tecnicas genericas.
- Gateways/adapters traducen persistencia, HTTP, mensajeria y proveedores.
- Presenters/mappers evitan filtrar modelos internos al exterior.
- Las entidades o modelos de dominio protegen invariantes cuando existen.

## Anti-patrones

- Capas vacias que solo pasan datos.
- Entidades ORM como modelo universal.
- Casos de uso `CreateXService` que no aportan regla ni boundary.
- Dependencias circulares entre capas.

## Validacion

- Tests de caso de uso sin framework.
- Revision de imports por capa.
- Decision documentada si se rompe una regla por pragmatismo.

## Fuentes canonicas

- Clean Architecture, Robert C. Martin: https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
- Martin Fowler, Presentation Domain Data Layering: https://martinfowler.com/eaaDev/PresentationDomainDataLayering.html
