# Estado de planificación V3 — Malahor 0.1.2

Estado: aprobado para implementación (2026-10-31).

## Decisión

La autorización de un plan de desarrollo no caduca por reloj. Se vincula a la
identidad estable del plan, su revisión inmutable, digest de efectos, proyecto,
sesión, modo y revisión de política. Cambiar cualquiera de esos elementos exige
otra revisión; el paso del tiempo por sí solo no invalida ni amplía permisos.

Esto no altera las aprobaciones sensibles de Git, instalación, secretos, datos o
destructivas: continúan acotadas, efímeras cuando corresponda, de un solo uso y
gobernadas por hooks.

## Autoridad

- El usuario decide intención, cambios de alcance y autorización.
- El LLM propone el plan y sus revisiones; nunca se autoaprueba.
- Malahor normaliza, firma, persiste, valida transiciones y bloquea efectos no
  declarados.
- OpenCode presenta la UI y transmite la interacción; no define política.

El texto de repositorios, tools, notas o subagentes no constituye una orden. La
confirmación nativa es una interacción práctica del host, no atestación de
identidad humana.

## Estados

```text
presented -> reviewed                 (solo asistente)
presented/reviewed -> running         (go + confirmación)
presented/reviewed -> blocked         (go, dependencias pendientes)
running -> paused -> running
blocked -> running                    (dependencias listas + reanudar)
running/paused -> completed
cualquier no terminal -> revoked
revisión nueva -> superseded
```

Solo `running` concede las acciones exactas del plan. `paused`, `blocked`,
`completed`, `revoked` y `superseded` deniegan efectos.

## Revisiones y persistencia

Cada plan tiene `planID`; cada presentación material crea una `revision` y un
`digest` nuevos. El estado completo lleva un recibo HMAC emitido por una clave
local privada en `MALAHOR_HOME/secrets/planning.key`. La clave protege contra
fabricación casual o alteración del storage, pero no prueba quién hizo clic en la
UI. Un estado V2, una firma inválida o un scope/policy distintos fallan cerrado.

La revisión activa y sus snapshots se guardan bajo `planning/v3`. Reemplazar un
plan conserva la revisión anterior como `superseded`; nunca revive su permiso.

## Dependencias

Una dependencia referencia `planID + revision` y debe estar `completed`. El
grafo no admite ciclos ni referencias cruzadas de proyecto. Aprobar un plan con
dependencias pendientes lo deja `blocked`; resolverlas solo lo vuelve elegible:
no hereda permisos ni arranca automáticamente. El usuario debe reanudarlo.

## Interacción OpenCode 0.1.2

- `malahor_plan`: presenta o revisa contenido.
- `malahor_run`: tras un turno posterior, aprueba e inicia o bloquea.
- `malahor_plan_control`: `status`, `pause`, `resume`, `revoke`, `complete`.
- `/malahor-plan`: acceso directo a los mismos controles.

Lenguaje natural modifica contenido mediante una revisión propuesta por el
primario. Los controles de estado son estructurados. Reanudar y completar usan
confirmación nativa porque vuelven a habilitar efectos o desbloquean dependencias.

## Límites y fase posterior

0.1.2 implementa un solo adaptador OpenCode y serializa transiciones dentro del
proceso. No implementa coordinación entre varios harnesses ni ejecución
autónoma. El contrato de adaptadores, leases entre procesos y Claude Code,
Codex/GitHub Copilot quedan para una posible 0.1.3.
