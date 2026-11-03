# Clasificación de tareas

Esta skill ayuda al primario a describir una tarea antes de actuar. No autoriza
ninguna tool, no crea grants y no sustituye Planning, hooks, permisos ni DENY.

## Señales

Evalúa cada señal como `low`, `medium`, `high` o `unknown`. `high` siempre
significa más incertidumbre o consecuencia.

- `specification`: claridad de objetivo, acción y resultado.
- `discovery`: cuánto hay que averiguar antes de decidir.
- `scope`: si los targets y acoplamientos están identificados.
- `openDecisions`: decisiones de producto o diseño pendientes.
- `reversibility`: coste de deshacer y alcance fuera del entorno local.
- `verifiability`: posibilidad de comprobar el resultado objetivamente.

## Prueba de cierre

Antes de proponer una mutación directa, expresa sin placeholders:

1. qué efecto se realizará;
2. sobre qué recursos exactos;
3. cómo se verificará objetivamente.

«Lo necesario», «los archivos relacionados», «mejorarlo» o un criterio subjetivo
no son un cierre válido.

## Rutas

- `inspect`: leer, buscar, listar, calcular o explicar sin mutar.
- `direct`: efecto, targets y verificación cerrados.
- `recognize`: lectura acotada para cerrar targets o efectos.
- `diagnose`: causa o estado desconocido; solo evidencia, sin corregir.
- `sdd`: meta abstracta, decisiones abiertas o cierre no alcanzable.
- `clarify`: la intención no se entiende; una sola pregunta.

Reconocimiento y diagnóstico son estados de evidencia, no permisos. Después de
ellos se vuelve a clasificar antes de mutar.

## Reglas

- El modelo aporta la evaluación; el runtime deriva la ruta.
- Toda mutación directa requiere aprobación nativa exacta.
- Lecturas, cálculos y diagnóstico read-only no piden aprobación redundante.
- Riesgo, ASK especializado y hard DENY son independientes de la ruta.
- Un cambio de alcance, target, reversibilidad o decisión invalida la evaluación
  anterior y exige reclasificar.
- Un error técnico o un DENY no se convierten en un plan por sí solos.
- No inventes targets, verificaciones ni remediaciones.

## Ejemplos (no son whitelist)

- «Lee estos archivos y explica el flujo» → `inspect`.
- «Corrige esta línea exacta y ejecuta su test» → `direct` si el cierre es claro.
- «Renombra esto; primero confirma los usos» → `recognize`, luego reclasificar.
- «Tenemos un fallo intermitente» → `diagnose`.
- «Quiero rediseñar la autorización» → `sdd`.
- «Hazlo mejor» → `clarify`.
