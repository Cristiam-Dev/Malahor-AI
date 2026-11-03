# Planificación por impacto verificado

Usa este método antes de `malahor_plan` para trabajo considerable. La
planificación no es una lista de pasos: es un mapa de impacto comprobado con
evidencia read-only.

## Preflight obligatorio

Antes de firmar un plan, revisa y deja constancia de:

- archivos y símbolos que se tocarán;
- call sites y consumidores;
- tests, fixtures y aserciones exactas;
- comandos de gate y su estado base;
- rutas, permisos, límites y superficies protegidas;
- modos de fallo previsibles: secretos, symlinks, imports, módulos duplicados,
  conteos de capacidades y orden de acciones;
- para cada edición, el bloque exacto que se reemplazará, su unicidad y la
  copia literal del contexto.

Solo lectura, `glob`, `grep`, Git local read-only, memoria y documentación. Si
falta evidencia, pide una aclaración o declara el bloqueo; no rellenes con
suposiciones.

## Ediciones verificadas

Ninguna acción edit se planifica sin haber leído el bloque que se reemplazará.
Confirma que aparece una sola vez, copia el oldString literal del archivo,
incluida la indentación, y conserva esa evidencia hasta la ejecución. Si el
bloque no es único o no coincide, no presentes el plan.

## Mapa de impacto

El plan debe incluir, antes de los pasos:

```text
cambio → archivo/símbolo → consumidor → test/fixture → gate → riesgo
```

Sin mapa no hay plan presentable.

## Slices pequeños

Un plan es un slice vertical verificable. Máximo recomendado: 12 acciones. Si
necesitas más, divide en fases. Cada slice declara objetivo, acciones exactas,
gates, criterio de cierre y qué queda fuera.

No mezcles una migración completa con la corrección de un fixture.

## Una edición por archivo

Una acción `edit` equivale a un archivo y se ejecuta una sola vez. Agrupa todos
los cambios de un archivo en una sola edición; no declares dos acciones `edit`
sobre el mismo recurso ni las ejecutes en paralelo. Si necesitas otro cambio en
ese archivo, presenta una revisión del plan.

## Dependencias reales

Declara dependencia solo si hay una necesidad de datos o de efecto. No ordenes
acciones por ceremonia. Nombra la dependencia pendiente en la presentación y en
el error.

## Revisión sin resetear progreso

Una revisión material conserva las acciones completadas cuyos inputs,
dependencias y efectos no cambiaron. Reinicia solo las afectadas y sus
descendientes. Muestra el delta: preservadas, cambiadas, añadidas y retiradas.

## Handoff explícito

La planificación termina con la presentación y una solicitud posterior de
ejecución. El plan no autoriza por sí solo. Las preguntas no son grants.

## Errores accionables

- Sin plan activo: indica que la operación requiere un plan y cómo crearlo o
  reanudarlo.
- Dependencia pendiente: nombra la acción y la dependencia.
- Acción ya completada: explica que la revisión la conserva.
- Gate fallido: muestra comando, código de salida y primer fallo saneado.

## Relación con OpenCode nativo

OpenCode separa un agente Plan read-only de la construcción. Malahor adopta ese
acierto: reconocimiento sin mutar el proyecto, plan artifact y handoff. La
autorización sigue siendo de Malahor; el plan file no es un grant.
