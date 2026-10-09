# programming/architecture/solid

## Usar Cuando

- Refactor, diseno de clases/modulos, extension de comportamiento o revision de acoplamiento.

## Versiones y compatibilidad

- Principios OO/generalizables; aplicarlos segun paradigma y lenguaje.
- No son reglas absolutas: sirven para razonar cambios, no para inflar abstracciones.

## Reglas canonicas sintetizadas

- SRP: un modulo debe tener una razon principal de cambio.
- OCP: preparar extension donde hay variacion real y costo de cambio repetido.
- LSP: subtipos no deben romper contratos observables de sus supertipos.
- ISP: interfaces segun consumidores, no segun implementadores.
- DIP: depender de abstracciones estables cuando los detalles son volatiles o dificiles de testear.

## Anti-patrones

- Interfaces de una sola implementacion sin beneficio.
- Herencia para compartir codigo trivial.
- Strategy/Factory/Adapter antes de confirmar variacion.
- Aplicar SOLID como dogma contra codigo simple.

## Validacion

- Nombrar razon de cambio de cada modulo afectado.
- Identificar consumidores antes de extraer interfaces.
- Comparar con alternativa simple y justificar costo.

## Fuentes canonicas

- Robert C. Martin, Design Principles and Design Patterns: https://web.archive.org/web/20200916072507/http://www.objectmentor.com/resources/articles/Principles_and_Patterns.pdf
- Martin Fowler, Refactoring: https://martinfowler.com/books/refactoring.html
