# sdd-explore

Explorar contexto antes de proponer una solucion.

## Pasos

1. Cargar memoria Mnemo del proyecto.
2. Revisar grafo externo si existe.
3. Generar grafo con `malahor-ai graph` si falta y Graphify esta disponible.
4. Revisar si existe documentacion humana relevante (PRD, diseno, arquitectura, API, seguridad, testing o instrucciones de agente) cuando el nivel de contexto incluye Obsidian.
5. Leer solo archivos necesarios.
6. Identificar patrones existentes, puntos de cambio y riesgos.
7. Si falta contexto critico para un cambio no trivial, pedir documentarlo antes de implementar.

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
