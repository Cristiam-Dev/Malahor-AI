# programming/quality/testing

## Usar Cuando

- Se agregan, corrigen o revisan pruebas automatizadas.

## Versiones y compatibilidad

- Adaptar herramientas al stack: Vitest/Jest/Testing Library/Playwright, JUnit/Spring Test, pytest, etc.
- No perseguir cobertura bruta si no mejora confianza en riesgos reales.

## Reglas profesionales

- Probar comportamiento observable, contratos e invariantes; no detalles privados.
- Piramide pragmatica: unit para reglas puras, integration para adapters/DB/IO, e2e para flujos criticos.
- Fixtures legibles y cercanos al dominio.
- Mocks solo para boundaries lentos/no deterministas; evitar mockear todo el mundo.
- Tests deterministas: sin orden aleatorio, sleeps innecesarios ni dependencia de red externa.
- Cubrir happy path, errores esperados y casos borde relevantes.

## Anti-patrones

- Snapshots gigantes.
- Tests que replican implementacion.
- Coverage artificial sin assertions significativas.
- E2E masivos para todo.

## Validacion

- Test falla antes del fix cuando aplica.
- Suite corre en CI.
- Casos criticos cubiertos con nivel de test adecuado.

## Referencias oficiales/canonicas

- Testing Library Guiding Principles: https://testing-library.com/docs/guiding-principles
- Playwright Docs: https://playwright.dev/docs/intro
- JUnit 5 User Guide: https://junit.org/junit5/docs/current/user-guide/
- Spring Boot Testing: https://docs.spring.io/spring-boot/reference/testing/index.html
