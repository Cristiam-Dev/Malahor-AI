# sdd-explore

Explorar contexto antes de proponer una solucion.

## Pasos

1. Cargar memoria Mnemo del proyecto.
2. Revisar la capacidad de contexto de codigo configurada, si existe.
3. Usar busquedas dirigidas cuando no haya una capacidad de contexto de codigo disponible; no instalar proveedores por conveniencia.
4. Revisar mediante `docs_search`/`docs_read` la documentacion relevante (PRD, diseno, arquitectura, API, seguridad, testing o instrucciones de agente); docs es externo e independiente del nivel de contexto.
5. Leer solo archivos necesarios.
6. Identificar patrones existentes, puntos de cambio y riesgos.
7. Si falta contexto critico para un cambio no trivial, documentarlo mediante `docs_write`/`docs_append` con control de version antes de implementar; nunca en el repo.
8. Resolver lenguaje natural a proyecto, area y path; buscar antes de crear y no pedir al usuario claves internas, SHA ni nombres de tools.

## Checklist de Contexto

- Producto: que se esta construyendo y para quien?
- Flujo: que hace el usuario y que estados existen (loading, empty, error, success)?
- Diseno: que reglas visuales o de componentes aplican?
- Arquitectura: que capas, contratos y dependencias se ven afectadas?
- Datos/API: cambian modelos, esquemas, endpoints o formatos?
- Seguridad: hay auth, permisos, secretos o datos sensibles?
- Calidad: que tests, typecheck, build o smoke validan el cambio?

## Salida

- Contexto relevante.
- Archivos o modulos afectados.
- Patrones detectados.
- Incertidumbres.
- Documentacion que falta o debe actualizarse.
- Proxima fase: `sdd-propose`.
