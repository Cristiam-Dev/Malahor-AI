# programming/backend/nestjs

## Usar Cuando

- Proyecto NestJS detectado por `@nestjs/core`, `nest-cli.json` o estructura `src/*.module.ts`.

## Versiones y compatibilidad

- Validar version NestJS y plataforma HTTP (`express`/`fastify`) antes de usar APIs especificas.
- Mantener compatibilidad con TypeScript config y metadata/decorators del proyecto.

## Reglas oficiales sintetizadas

- Modulos por capacidad funcional; imports/exports explicitos.
- Controllers delgados: request mapping, pipes/DTOs, auth decorators y delegacion.
- Providers/casos de uso contienen reglas; evitar meter dominio en decorators del framework si buscas arquitectura limpia.
- Pipes para validacion/transformacion; Guards para authn/authz; Interceptors para cross-cutting; Filters para errores.
- DTOs con validacion runtime y mensajes seguros.
- ConfigModule o equivalente centralizado y validado.
- Tests unitarios de providers y e2e de rutas criticas.

## Anti-patrones

- `SharedModule` gigante.
- Providers con demasiadas dependencias.
- Repositories inyectados directo en controllers.
- Decorators de Nest contaminando entidades de dominio puras.

## Validacion

- `npm test`/runner equivalente.
- e2e smoke con auth, validation pipes y errores.
- Verificar bootstrap config y global pipes/filters/interceptors.

## Referencias oficiales

- NestJS Docs: https://docs.nestjs.com/
- Modules: https://docs.nestjs.com/modules
- Providers: https://docs.nestjs.com/providers
- Controllers: https://docs.nestjs.com/controllers
- Pipes: https://docs.nestjs.com/pipes
- Guards: https://docs.nestjs.com/guards
- Testing: https://docs.nestjs.com/fundamentals/testing
