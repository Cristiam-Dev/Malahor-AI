# programming/backend/java

## Usar Cuando

- Java backend, librerias JVM o proyectos Maven/Gradle.

## Versiones y compatibilidad

- Baseline profesional: Java LTS segun proyecto (17/21/25). Validar `maven-compiler`, toolchain, Gradle JVM y runtime.
- Recomendaciones seguras contrastadas con JDK 21 docs; no usar features preview sin decision explicita.

## Reglas oficiales sintetizadas

- Diseñar APIs y dominios con nombres claros; preferir inmutabilidad en DTOs/value objects cuando sea practico.
- Excepciones: distinguir error esperado, error de dominio y fallo tecnico; conservar causa original.
- Usar try-with-resources para recursos cerrables.
- Streams y lambdas deben mejorar legibilidad; evitar pipelines opacos con efectos laterales.
- Configuracion fuera del binario; secretos nunca hardcodeados.
- Concurrencia: preferir abstracciones del JDK/framework; documentar ownership, cancelacion y timeouts.
- Seguridad: validar inputs, parametrizar queries y revisar serializacion/deserializacion.

## Anti-patrones

- Clases `Util` gigantes.
- `Optional` como campo serializable o parametro sin motivo.
- Capturar `Exception` y continuar sin accion.
- Mutabilidad global compartida.

## Validacion

- Unit tests de reglas puras.
- Integration tests para IO/persistencia.
- Build Maven/Gradle, analisis estatico y dependency scan si existe.

## Referencias oficiales

- JDK 21 Docs: https://docs.oracle.com/en/java/javase/21/
- Java API: https://docs.oracle.com/en/java/javase/21/docs/api/
- Secure Coding Guidelines: https://www.oracle.com/java/technologies/javase/seccodeguide.html
- Java Language Specification: https://docs.oracle.com/javase/specs/
