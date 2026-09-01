# pattern-advisor

Evaluar decisiones de diseno tecnico antes de implementar cambios con impacto estructural.

## Usar Cuando

- Se elija arquitectura, patron o estructura de modulos.
- Existan varias formas razonables de resolver el problema.
- El cambio afecte contratos, persistencia, integraciones o limites entre capas.
- El usuario pida refactor, abstraccion, desacoplamiento o escalabilidad.

## Objetivo

Recomendar el patron mas simple que resuelve el problema actual sin introducir abstracciones prematuras.

## Preguntas Guia

1. Que problema concreto resuelve el patron?
2. Existe evidencia de variacion o solo una implementacion actual?
3. El patron reduce acoplamiento real o solo mueve complejidad?
4. Que coste agrega en nombres, archivos, tests y mantenimiento?
5. Que alternativa mas simple existe?
6. Como se verificara que el diseno funciona?

## Patrones A Considerar

- Funcion directa: default para cambios simples.
- Modulo de dominio: cuando varias funciones comparten reglas.
- Adapter: cuando se encapsula una dependencia externa.
- Repository: cuando hay persistencia reemplazable o queries complejas.
- Strategy: cuando hay variantes reales de comportamiento.
- Factory: cuando crear objetos requiere reglas o seleccion dinamica.
- Command: cuando una accion necesita validacion, auditoria o cola.
- Facade: cuando se simplifica una API interna compleja.
- Event: cuando otros modulos reaccionan sin acoplarse al emisor.

## Anti-Patrones

- Crear interfaces con una sola implementacion sin necesidad concreta.
- Dividir archivos antes de que exista complejidad real.
- Introducir factories para constructores triviales.
- Usar eventos para flujos que requieren respuesta sincrona clara.
- Ocultar reglas de negocio dentro de adaptadores de infraestructura.
- Agregar compatibilidad hacia atras sin consumidor externo o dato persistido.

## Salida

- Patron recomendado.
- Alternativa mas simple.
- Por que no usar patrones mas pesados.
- Cambios esperados en archivos o modulos.
- Riesgos y validacion.
- Decision para guardar en Mnemo si afecta arquitectura.

## Integracion Con SDD

- Usar antes de `sdd-design` cuando el diseno no sea obvio.
- Si recomienda una decision arquitectonica, guardarla con Mnemo como `architecture` o `decision`.
- Si no hay patron necesario, decirlo explicitamente y continuar con la solucion simple.
