# programming/frontend/angular

## Usar Cuando

- Proyecto Angular detectado por `@angular/core`, `angular.json`, Angular CLI o estructura `src/app`.
- Componentes, routing, forms, HTTP, DI, signals, RxJS, SSR/hydration o testing Angular.

## Versiones y compatibilidad

- Baseline 2026-10: Angular moderno segun `angular.dev` v22.
- Para proyectos Angular 16-21, validar disponibilidad exacta de APIs (`signals`, control flow, standalone, signal forms) antes de refactorizar.
- Mantener consistencia con el estilo existente si el proyecto aun usa NgModules.

## Reglas oficiales sintetizadas

- Organizar por feature area, no por carpetas genericas de tipo tecnico cuando el dominio crece.
- Preferir componentes/directivas enfocados en presentacion; extraer reglas no visuales a funciones, services o casos de uso.
- Preferir `inject()` cuando el proyecto ya adopta estilo moderno; no mezclar estilos sin motivo.
- Usar signals/computed para estado local y derivado; no meter logica compleja en templates.
- Marcar `readonly` inputs/outputs/queries signal-based y `protected` miembros usados solo por template.
- Preferir bindings nativos `class`/`style` frente a `ngClass`/`ngStyle` salvo necesidad concreta.
- RxJS: evitar subscribes anidados, limpiar con `takeUntilDestroyed`, nombrar streams por significado.
- Formularios: tipar modelos, mostrar errores accesibles y mantener validaciones cerca del campo o schema.
- HTTP: centralizar clientes, tipar DTOs, manejar loading/error/empty y evitar filtrar detalles internos.
- Routing: lazy loading por feature, guards/resolvers funcionales si el proyecto los usa, errores y fallback claros.

## Anti-patrones

- Logica de dominio pesada dentro del componente.
- Estado global para datos efimeros de pantalla.
- `any` para esquivar contratos de DTO.
- Suscripciones manuales sin cleanup.
- Templates con expresiones complejas o llamadas costosas repetidas.

## Validacion

- `ng test` o runner del proyecto; tests de componente/servicio segun riesgo.
- `ng build` o build de produccion.
- Revisar accesibilidad: labels, foco, teclado, mensajes de error.
- Cubrir estados loading/error/empty/success en UI.

## Referencias oficiales

- Angular Overview: https://angular.dev/overview
- Angular Style Guide: https://angular.dev/style-guide
- Signals: https://angular.dev/guide/signals
- Components: https://angular.dev/guide/components
- Forms: https://angular.dev/guide/forms
- HTTP Client: https://angular.dev/guide/http
- Testing: https://angular.dev/guide/testing
