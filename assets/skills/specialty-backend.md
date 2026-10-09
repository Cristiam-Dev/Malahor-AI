# specialty-backend

Guia de especialidad para trabajo de backend: APIs, servicios, persistencia y datos. Aplica a Node (Express, Fastify, NestJS), Java (Spring Boot), Python (FastAPI, Flask) y Go.

## Usar Cuando

- Se crean o modifican APIs REST, servicios, workers o jobs.
- Se toca persistencia: SQL, NoSQL, bases vectoriales, migraciones.
- La tarea pide Java/Spring, Node/Express, Python o Go, o el stack detectado es backend.
- Se integran dependencias externas, colas, caches o autenticacion de servicios.

## Preguntas Guia

1. Que contrato expone el servicio y quien lo consume?
2. Que capas se necesitan de verdad (routes, servicios, repositorio) y cuales sobran hoy?
3. Que datos se persisten, como se consultan y como se migran?
4. Como se validan entradas y como se normalizan errores?
5. Como se configuran secretos y entornos sin exponerlos?
6. Que pasa con fallos, reintentos y limites de carga?

## Puntos de Revision

- REST: recursos claros, metodos correctos, codigos de estado coherentes, paginacion explicita cuando aplica.
- Validacion: rechazar temprano con mensajes accionables; nunca confiar en la entrada del cliente.
- Errores: un solo formato de error con contexto util y sin stack traces al cliente.
- Persistencia: transacciones donde la atomicidad importa, indices para las consultas reales, migraciones versionadas.
- Secretos: solo via entorno o gestor de secretos; nunca en codigo, configs commiteadas ni logs.
- Logs: eventos clave con contexto, sin datos sensibles.
- Spring Boot/Java: usar constructor injection, DTOs para contratos externos, validacion con Bean Validation, `@Transactional` solo donde hay unidad atomica, y tests de slice/integracion cuando toque persistencia o seguridad.
- Seguridad de APIs: autorizar por recurso, no solo por rol global; auditar cambios de auth, tokens, cookies, CSRF/CORS y permisos.

## Anti-Patrones

- Endpoints que mezclan logica de negocio, acceso a datos y serializacion.
- Consultas N+1 o carga de tablas enteras para listar.
- Migraciones destructivas sin plan de rollback.
- Capturar errores y tragarlos sin registro ni respuesta.
- Hardcodear secretos, puertos u hosts.
- Abstracciones (interfaces, factories) antes de existir una segunda implementacion.

## Seguridad

- Autenticacion y autorizacion en cada endpoint protegido; verificar propiedad de recursos.
- Limitar tamanos, tasas y entradas; escapar o parametrizar consultas.
- No exponer informacion interna en errores ni encabezados.

## Salida

- Resumen del contrato y las capas afectadas.
- Lista de archivos o modulos a tocar.
- Riesgos y como validarlos.
- Decisiones relevantes para guardar en Mnemo.

## Integracion Con SDD

- Usar dentro de `sdd-design` y `sdd-apply` cuando el cambio toque backend.
- Si hay decision de arquitectura (capas, contratos, persistencia), guardarla en Mnemo como `architecture` o `decision`.
- Si el cambio es pequeno y localizado, no inflar el flujo SDD.
