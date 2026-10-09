# programming/backend/spring-boot

## Usar Cuando

- Spring Boot, Spring MVC/WebFlux, Data, Security, Actuator, Testcontainers o buildpacks.

## Versiones y compatibilidad

- Baseline 2026-10: Spring Boot 4.x existe; muchos proyectos siguen en 3.x. Validar version real antes de aplicar APIs.
- Revisar system requirements oficiales para version de Java, Spring Framework y plugin Maven/Gradle.

## Reglas oficiales sintetizadas

- Aprovechar auto-configuracion y externalized configuration; no sobreconfigurar sin necesidad.
- Constructor injection; evitar field injection.
- `@SpringBootApplication` en paquete raiz coherente para component scanning predecible.
- Controllers delgados: validacion, auth boundary, delegacion a casos de uso/servicios y DTOs estables.
- `@Transactional` en boundaries de caso de uso; documentar transacciones que cruzan aggregates/IO.
- No exponer entidades JPA como contrato publico.
- Actuator: habilitar health/metrics utiles, restringir endpoints sensibles.
- Security: autenticacion/autorizacion explicitas, CORS/CSRF segun cliente, errores seguros.
- Testing: slices (`@WebMvcTest`, `@DataJpaTest`) cuando bastan; integration/Testcontainers cuando importa el stack real.

## Anti-patrones

- Entidades JPA serializadas directo a JSON publico.
- Lazy loading accidental durante serializacion.
- `@Transactional` en controllers.
- Tests `@SpringBootTest` para todo sin necesidad.
- Config sensible en `application.yml` versionado.

## Validacion

- Maven/Gradle build.
- Tests por capa/slice + integration critical path.
- Revisar Actuator expuesto, CORS/CSRF y autorizacion por recurso.

## Referencias oficiales

- Spring Boot Docs: https://docs.spring.io/spring-boot/index.html
- Structuring Code: https://docs.spring.io/spring-boot/reference/using/structuring-your-code.html
- Externalized Configuration: https://docs.spring.io/spring-boot/reference/features/external-config.html
- Testing: https://docs.spring.io/spring-boot/reference/testing/index.html
- Actuator: https://docs.spring.io/spring-boot/reference/actuator/index.html
- Security: https://docs.spring.io/spring-security/reference/
