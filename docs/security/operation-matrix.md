# Matriz de operaciones — contrato de seguridad runtime v1

Estado: v1 aprobada para implementación (2026-10-21).
Dueño: T-5.1.8. Implementación: T-5.1.3. Cierre verificable: T-5.5.5.

Esta matriz es normativa. Cada fila identifica una operación sensible, el control
obligatorio, el punto de ejecución real y el comportamiento si ese punto no
existe. **Si no hay mediación suficiente, se bloquea la capacidad sensible; no se
presume cobertura.**

Notas:

- Los nombres V2 son el objetivo del contrato; T-5.1.3 verifica la API real y
  documenta cualquier diferencia.
- Un `after-hook` solo sirve para auditoría/captura filtrada; no deshace un efecto
  ni sustituye un control previo.
- Un `hooks check` voluntario no prueba cobertura.
- Las llamadas anidadas, scripts, Code Mode y herramientas alternativas deben
  pasar por el mismo control.
- V1 usa adaptador equivalente solo si media antes del efecto; si no, se bloquea.

## 1. Archivos e indexado

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| FILE-READ-01 | Leer archivo/ruta | Autorización de lectura, raíz real, denylist y secretos | `tool.hook("execute.before")` + resolvedor de rutas | Denegar lectura | T-5.1.3 |
| FILE-WRITE-01 | Crear/modificar/borrar archivo | Autorización de escritura, raíz real y preview si es destructiva | `tool.hook("execute.before")` + resolvedor | Denegar escritura | T-5.1.3 |
| FILE-ROOT-01 | Symlink/junction, `..`, ruta relativa o indirecta | Resolver ruta canónica y verificar raíz | Resolvedor previo al efecto | Denegar ruta no resuelta | T-5.1.3 |
| FILE-SECRET-01 | Leer/indexar/enviar secretos | Exclusión de secretos en contexto e índice | Clasificador + hook previo | Denegar el contenido | T-5.8/5.13 |
| FILE-INDEX-01 | Indexar en CodeGraph | Autorización de raíz y exclusión de secretos | Hook previo + indexador | No indexar; denegar | T-5.9.4 |
| FILE-EXPORT-01 | Exportar archivo/contexto | Clasificación, redacción y aprobación si sale de raíces | Hook previo + aprobación | Denegar exportación | T-5.8/5.13 |

## 2. Shell y procesos

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| SHELL-EXEC-01 | Ejecutar comando/script | Allowlist, denylist y autorización previa | `shell.hook("create.before")` + `tool.hook` | Denegar ejecución | T-5.1.3 |
| SHELL-ENV-01 | Pasar entorno/credenciales | Entorno mínimo; sin tokens/credenciales | `shell.hook("create.before")` | Denegar variables sensibles | T-5.1.3 |
| SHELL-TIMEOUT-01 | Comando sin límite | Timeout obligatorio | `shell.hook("create.before")` | Denegar comando | T-5.1.3 |
| SHELL-INDIRECT-01 | Wrapper, shebang, script, `eval`, subproceso | Inspección de ejecución indirecta | Hook previo + parser/inspección | Bloquear el comando | T-5.1.3 |
| SHELL-ISO-01 | Aislar procesos/red | Control externo de host | No es un hook de Malahor | Bloquear capacidades que dependan de aislamiento | T-5.1.8/T-5.5.5 |

## 3. Git

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| GIT-STAGE-01 | `git add`/stage | Consentimiento real y autorización de rutas | Hook previo + CLI | Denegar stage | T-5.1.3 |
| GIT-COMMIT-01 | Commit | Consentimiento, escaneo staged y checks si aplica | Hook previo + CLI | Denegar commit | T-5.1.3 |
| GIT-PUSH-01 | Push | Aprobación, escaneo outgoing y checks ligados a revisión | Hook previo + CLI | Denegar push | T-5.1.3 |
| GIT-DESTRUCT-01 | Reset/rebase/checkout/force | Preview, respaldo y aprobación | Hook previo + CLI | Denegar operación | T-5.4.2 |
| GIT-SCAN-01 | Escanear staged/outgoing | Secretos/PII y cambios inesperados | Antes de commit/push | Denegar envío | T-5.8/5.13 |
| GIT-CHECK-01 | Checks antes de push | Resultado ligado a la revisión exacta | Pre-push + registro | Denegar push | T-5.1.3 |

## 4. Memoria y documentación

Un scope no es una ACL. Toda operación, incluso las indirectas, autoriza cliente
y proyecto.

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| MEM-GET-01 | Obtener por ID | Cliente/proyecto del registro y scope autorizado | Handler MCP/CLI + hook previo | Denegar lectura | T-5.3.2 |
| MEM-BRIEF-01 | Brief/related | Sin fuga cruzada; allowlist de relaciones | Handler + hook previo | Denegar relación | T-5.3.2 |
| MEM-ANCESTOR-01 | Ancestros/global | Autorización por cliente/proyecto; global exige aprobación | Handler + hook previo | Denegar scope global | T-5.3.3 |
| MEM-SEARCH-01 | Búsqueda all/subtree | Limitar a scopes autorizados | Handler + hook previo | Denegar búsqueda amplia | T-5.3.3 |
| MEM-TREE-01 | Tree/rollup | Autorización y filtrado por cliente | Handler + hook previo | Denegar agregación | T-5.3.3 |
| MEM-PROMOTE-01 | Promover/migrar/administrar | Aprobación, preview y respaldo | Handler + hook previo | Denegar operación | T-5.3.4/T-5.5.4 |
| MEM-WRITE-01 | Guardar/actualizar | Cliente/proyecto, clasificación y secretos | Handler + hook previo | Denegar escritura | T-5.3.2 |
| DOC-OBSIDIAN-01 | Leer/escribir nota vía `vault_*` | Raíz, cliente/proyecto, frontmatter y sync seguro | Handler MCP + hook previo | Denegar operación | T-5.9.4 |

## 5. Persistencia y contexto

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| CTX-SAVE-01 | Guardar contexto/memoria | Clasificación, redacción y bloqueo de secretos | Hook previo + handler | Denegar guardado | T-5.3.2 |
| CTX-COMPACT-01 | Compactar contexto | Filtrado antes de compactar; sin secretos | `session.hook` + hook previo | Denegar compactación | T-5.1.3 |
| CTX-SUBAGENT-01 | Capturar subagente | Opt-in, filtrado y mismo suelo | Hook previo + sesión | Denegar captura | T-5.1.3 |
| CTX-EXPORT-01 | Exportar contexto | Aprobación y redacción | Hook previo | Denegar exportación | T-5.8/5.13 |
| CTX-LOG-01 | Logs/diagnóstico | Sin payloads, secretos ni PII | Logger + hook previo | Denegar log sensible | T-5.8/5.13 |

## 6. Destructivas y versiones

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| DEST-PREVIEW-01 | Preview de borrado/movimiento/migración | Preview acotado, sin secretos | Hook previo + CLI | Denegar operación | T-5.4.2 |
| DEST-APPLY-01 | Aplicar cambio destructivo | Aprobación vinculada, respaldo y revalidación | Hook previo + CLI | Denegar efecto | T-5.4.2 |
| DEST-VERSION-01 | Cambio de versión/digest | Invalidar aprobación previa | Revalidación previa | Denegar si cambió | T-5.4.2 |
| DEST-WRITE-01 | Escritura documental/remota | Conditional write/`ifMatch` cuando exista | Handler + hook previo | Denegar escritura ciega | T-5.9.4 |
| DEST-AFTER-01 | “Deshacer” con after-hook | No usar after-hook para deshacer filtración | Solo auditoría | Denegar el enfoque | T-5.1.8 |

## 7. Egress, modelo y red

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| EGRESS-PROVIDER-01 | Elegir proveedor/endpoint | Allowlist, identidad y TLS | Hook de sesión/permiso | Denegar proveedor | T-5.7 |
| EGRESS-PROMPT-01 | Enviar prompt/adjuntos | Clasificación, redacción y canal aprobado | Hook previo + sesión | Denegar envío | T-5.7 |
| EGRESS-AUX-01 | Continuaciones/títulos/compactación/aux | Mismo control que prompt | Hook de sesión | Denegar canal | T-5.7 |
| EGRESS-HTTP-01 | HTTP/WebSocket | Endpoint/protocolo permitido | Hook de red/tool | Denegar conexión | T-5.7 |
| EGRESS-MCP-01 | MCP/shell/fetch de Code Mode | Mismo control; sin bypass | Hook de tool/shell | Denegar capacidad | T-5.7 |
| EGRESS-MODEL-01 | Selección/detección automática | Prohibida | Config/validación | Denegar cambio | T-5.7 |
| EGRESS-UNMEASURABLE-01 | Canal no medible | Restringir; no presumir cobertura | Evaluación de cobertura | Bloquear canal | T-5.7/T-5.5.5 |

## 8. Integraciones y delegación

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| INT-MCP-01 | Invocar tool MCP | Allowlist server/tool, argumentos y destino | `tool.hook("execute.before")` | Denegar tool | T-5.10/5.11 |
| INT-MCP-02 | Servidor MCP no confiable | Integridad/procedencia | Validación previa | Denegar servidor | T-5.10/5.11 |
| INT-SKILL-01 | Cargar skill/plugin | Allowlist e integridad | Validación previa | Denegar carga | T-5.10/5.11 |
| INT-SUBAGENT-01 | Delegar a subagente | Mismo suelo, contexto filtrado | Hook de sesión/tool | Denegar delegación | T-5.1.3 |
| INT-TEXT-01 | Texto de repo/nota como instrucción | No es autorización | Evaluador de política | Ignorar y auditar | T-5.1.3 |
| INT-UNKNOWN-01 | Integración no aprobada | Bloqueo por defecto | Validación previa | Denegar | T-5.10/5.11 |

## 9. Auditoría

| ID | Operación | Control obligatorio | Punto de ejecución V2 | Si no hay mediación | Dueño |
|---|---|---|---|---|---|
| AUDIT-DECISION-01 | Registrar decisión | Evento sin payloads, con regla/operación/contexto | Motor antes del efecto + event | Denegar si es obligatoria | T-5.1.3 |
| AUDIT-APPROVAL-01 | Registrar aprobación | Referencia nonce/hash, sin payload | Motor + event | Denegar operación | T-5.1.3 |
| AUDIT-UNAVAILABLE-01 | Auditoría no disponible | Fail closed si la política la exige | Chequeo previo | Denegar operación | T-5.1.3 |
| AUDIT-PAYLOAD-01 | Payload en log/auditoría | Prohibido | Esquema + logger | Denegar escritura | T-5.8/5.13 |
| AUDIT-RETENTION-01 | Retención/rotación | Política corporativa; default local | Job de rotación | Denegar si no se puede cumplir | T-5.1.3 |

## 10. Cobertura V1/V2

| Caso | V2 | V1/otros | Si falta |
|---|---|---|---|
| Autorización previa | `permission.hook("evaluate")` + permisos | Adaptador equivalente | Bloquear capacidad |
| Argumentos | `tool.hook("execute.before")` | Adaptador equivalente | Bloquear tool |
| Shell | `shell.hook("create.before")` | Adaptador equivalente | Bloquear shell |
| Sesión/contexto | `session.hook` | Adaptador equivalente | Bloquear canal |
| Auditoría | `event`/after-hook | Adaptador equivalente | Denegar si es obligatoria |
| Cobertura completa V1 | — | T-5.6.4 | No prometer paridad |

## 11. Pruebas mínimas de T-5.1.3/T-5.5.5

- `profile: "off"` no desactiva el suelo corporativo.
- `ask` pendiente bloquea; `deny` bloquea; error/timeout crítico deniega.
- Aprobación de otra operación/recurso/cliente/versión no autoriza.
- Llamada indirecta/Code Mode/script no evade el control.
- After-hook no se usa para deshacer una filtración.
- `hooks check` voluntario no se reporta como cobertura.
- Sin secretos/PII en logs, auditoría, errores ni modelo.
- Sin fuga entre clientes en get/related/ancestros/global/search/tree/rollup.
- Si falta auditoría obligatoria, la operación se deniega.
- `doctor` reporta brechas y no certifica aislamiento/cumplimiento.
