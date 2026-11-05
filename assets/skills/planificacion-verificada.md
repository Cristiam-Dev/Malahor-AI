# Planificación por impacto verificado

Usa este método antes de `malahor_plan` para trabajo considerable. Un plan no es
una lista de pasos: es un dossier de preflight con evidencia read-only que
demuestra que el plan puede ejecutarse de una sola vez.

## Regla de cierre

No presentes `malahor_plan` hasta completar el dossier. Si falta un punto, no
hay plan: reporta el bloqueo y qué evidencia falta. El plan no se usa para
descubrir problemas durante la ejecución.

## Dossier obligatorio

### 1. Objetivo y aceptación ejecutable

Define qué significa «terminado» con comandos, archivos y resultados concretos.
Cada criterio debe poder verificarse sin interpretación.

### 2. Mapa de cambios por archivo

Para cada archivo:

- símbolos y líneas que se tocarán;
- bloque exacto a reemplazar (oldString literal, con indentación);
- confirmación de que aparece una sola vez;
- confirmación de que **todos** los cambios del archivo caben en una sola
  edición contigua o en un `replaceAll` único.

Si los cambios no caben en una sola edición, divide el trabajo por archivo en
planes separados. No presentes un plan que necesitará otra edición del mismo
archivo.

### 3. Mapa de consumidores y aserciones

- `grep` de call sites y consumidores de cada símbolo cambiado.
- Tests y fixtures que tocan esos símbolos.
- Aserciones exactas que se romperán: listas de propiedades, formatos de salida,
  firmas, conteos, snapshots.
- Cómo se actualiza cada aserción dentro del mismo plan.

### 4. Mapa de artefactos y orden de gates

- Qué tests consumen bundles, builds o artefactos generados.
- Orden exacto: ediciones → typecheck → build (si corresponde) → pruebas
  focalizadas → suite → rollout.
- Ningún gate puede depender de un artefacto que se genera después.
- Comandos literales y estado base de cada gate.

### 5. Simulación del contrato runtime

Para cada tool, puerta o campo nuevo:

- qué devuelve la tool;
- qué ve el agente;
- qué espera la siguiente tool;
- dónde puede haber un deadlock (un dato que el agente no puede obtener).

Verifica el flujo completo con un stub o test antes de planificar. Si la puerta
exige algo que la tool anterior no expone, el diseño está mal.

### 6. Fallos esperados

Enumera los errores y warnings previsibles de typecheck, pruebas, build, hooks,
update y doctor. Para cada uno: causa, mensaje esperado y respuesta exacta.
Nada de «ya veremos».

### 7. Plan de acciones

- Máximo 12 acciones.
- Dependencias reales; ninguna acción depende de una posterior.
- Una edición por archivo, con todos sus cambios en un solo bloque.
- Gates después de las ediciones y en el orden verificado.
- Cada acción con recurso y criterio de aceptación.

### 8. Evidencia por afirmación

Cada punto del dossier referencia la lectura, el `grep`, el test o la simulación
que lo sustenta. Sin evidencia, la afirmación no cuenta.

### 9. Condición de parada

Si falta cualquier punto, no presentes el plan. Reporta el bloqueo, la evidencia
que falta y la siguiente acción concreta.

## Checklist final

- [ ] Objetivo y aceptación ejecutables.
- [ ] Todos los cambios de cada archivo caben en una sola edición.
- [ ] Consumidores y aserciones identificados y cubiertos.
- [ ] Orden de gates verificado con artefactos.
- [ ] Contrato runtime simulado sin deadlocks.
- [ ] Fallos esperados y respuestas definidos.
- [ ] ≤12 acciones, dependencias reales, una edición por archivo.
- [ ] Evidencia para cada afirmación.
- [ ] Condición de parada explícita.

## Slices y revisión

Un plan es un slice vertical verificable. No mezcles una migración completa con
la corrección de un fixture. Una revisión material conserva las acciones
completadas cuyos inputs, dependencias y efectos no cambiaron y muestra el delta.
La revisión no sustituye un preflight incompleto.

## Handoff

La planificación termina con la presentación y una solicitud posterior de
ejecución. El plan no autoriza por sí solo. Las preguntas no son grants.

## Errores accionables

- Sin plan activo: indica cómo crearlo o reanudarlo.
- Dependencia pendiente: nombra la acción y la dependencia.
- Acción ya completada: explica que la revisión la conserva.
- Gate fallido: muestra comando, código de salida y primer fallo saneado.

## Relación con OpenCode nativo

OpenCode separa un agente Plan read-only de la construcción. Malahor adopta ese
acierto: reconocimiento sin mutar el proyecto, plan artifact y handoff. La
autorización sigue siendo de Malahor; el plan file no es un grant.
