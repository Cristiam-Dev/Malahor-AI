# AI Agent Instructions

## 1. Contexto del proyecto

Proyecto:

Proposito:

Usuarios principales:

## 2. Fuente de verdad

Antes de cambios no triviales, leer la documentacion relevante del vault y la memoria Mnemo.

Documentos base:

- PRD
- Design system
- Architecture
- Database/API/Security cuando existan
- Testing

## 3. Reglas generales

- No inventar requisitos de negocio.
- No crear archivos en el repo para contexto de Malahor.
- Reutilizar patrones existentes.
- Seguir arquitectura, seguridad y convenciones documentadas.
- No exponer secretos.
- Evitar dependencias innecesarias y cambios no relacionados.

## 4. Planificacion

Antes de implementar:

1. Revisar contexto y codigo relevante.
2. Identificar archivos afectados.
3. Identificar cambios de datos/API/seguridad.
4. Identificar tests necesarios.
5. Proponer plan.

## 5. Validacion

Despues de implementar:

- Tests
- Typecheck/lint/build
- Revision de diff
- Chequeo de documentacion a actualizar
- Resumen en Mnemo

## 6. Conflictos

Si los requisitos se contradicen o falta informacion, no adivinar: pedir aclaracion.
