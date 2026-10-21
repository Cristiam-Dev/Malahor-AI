# Contrato de seguridad runtime bancario — v1

Estado: v1 aprobada para implementación (2026-10-21).
Dueño: T-5.1.8. Integración obligatoria: T-5.1.3. Cierre verificable: T-5.5.5.
Base: §13 del plan Fase 5.

Este documento es normativo. No implementa el runtime ni crea un segundo motor
de hooks: T-5.1.3 reutiliza `src/cli/core/hooks/` y sus adaptadores.

Palabras normativas: **DEBE**, **NO DEBE**, **DEBERÍA**.

## 1. Alcance y no objetivos

Alcance:

- ingeniería en desarrollo/sandbox, sin credenciales ni escritura en producción;
- política efectiva versionada, fuentes de confianza y suelo corporativo;
- decisiones y aprobaciones verificables;
- cobertura de operaciones sensibles en plugin, CLI, MCP y Code Mode;
- secretos, datos personales, aislamiento por cliente, egress y auditoría;
- límites de host/SO/red y evidencia para `doctor`.

No objetivos:

- certificar cumplimiento regulatorio ni sustituir la aprobación del banco;
- aislar procesos, red o credenciales por sí solo;
- modificar políticas administradas del entorno;
- incorporar un servicio externo, PKI o firma criptográfica en v1;
- usar el modelo como autoridad de seguridad;
- detectar o seleccionar modelos automáticamente;
- prometer paridad V1/V2 cuando el host no ofrece mediación suficiente.

## 2. Autoridad y modelo de confianza

### 2.1 Autoridad

La evaluación de seguridad DEBE ser determinista y ejecutada por el motor de
hooks/permisos, no por el modelo. El agente, los especialistas, el repositorio,
las notas, los resultados de tools y los prompts son datos no confiables.

Una instrucción del usuario para desarrollar una función no autoriza una
operación productiva. Un “go” al desarrollo no es una aprobación bancaria.

### 2.2 Jerarquía de fuentes

De mayor a menor autoridad:

1. **Suelo built-in de Malahor**.
2. **Política corporativa administrada** por el host (solo lectura).
3. **Política de proyecto** (solo puede endurecer).
4. **Política local/default** (solo puede endurecer).
5. **Perfil** (`off`, `light`, `standard`, `strict`, `release`): solo ajusta
   controles opcionales.

El suelo built-in incluye, como mínimo:

- ningún secreto/credencial en contexto, logs, auditoría o modelo;
- preview, respaldo y aprobación para operaciones destructivas;
- aprobación vinculada a operación, recursos, cliente y versión;
- `ask` pendiente no autoriza;
- error/timeout/ausencia de un control crítico deniega la operación protegida;
- ningún canal de egress no aprobado ni no medible se presume cubierto;
- la política no puede ser rebajada por `off`, `--force`, `--yes`, “Allow
  always”, un perfil, una variable de entorno ni un metadato del agente.

### 2.3 Política corporativa

Rutas propuestas:

- Linux/WSL: `/etc/malahor/security-policy.json`.
- Windows: `%ProgramData%\Malahor\security-policy.json`.
- macOS: `/Library/Application Support/Malahor/security-policy.json`.
- Override: `MALAHOR_CORPORATE_POLICY`, aceptado solo si el archivo pasa la
  verificación de propiedad/ACL.

Requisitos:

- DEBE ser propiedad de root/administrador y no escribible por el usuario.
- La existencia del archivo no implica confianza; se verifican ubicación,
  propiedad, ACL y legibilidad.
- Si la política corporativa es obligatoria y falta, es inválida o no se puede
  verificar, las operaciones sensibles se deniegan.
- Un campo desconocido en política corporativa invalida la política (fail
  closed). Un campo desconocido en política local se ignora con WARN.
- La política corporativa NO DEBE ser reescrita por Malahor en V2.

### 2.4 Política efectiva y merge

La política efectiva DEBE registrar:

- `contractVersion`, `schemaVersion`, `policyVersion`, `issuer`, `issuedAt`;
- hash canónico y procedencia de cada capa cargada;
- reglas efectivas después del merge;
- controles ausentes, inválidos o no evaluables.

Merge monótono:

- Un booleano de seguridad solo puede pasar de `false` a `true`; nunca al revés.
- Las allowlists se intersectan.
- Las denylists se unen.
- Los límites numéricos toman el valor más restrictivo.
- Un perfil no puede desactivar el suelo built-in/corporativo.
- Si una capa local intenta aflojar una regla, se conserva la más estricta y se
  emite un WARN en `doctor`/auditoría.

El esquema normativo de una capa es `docs/security/policy.schema.json` v1. El
esquema valida estructura; la monotonía y la autoridad se aplican en runtime.

## 3. Decisiones

- `allow`: no hay violación; la operación continúa.
- `warn`: solo para controles explícitamente no críticos; informa y continúa.
- `ask`: suspende la operación hasta una aprobación verificable.
- `deny`: no hay efecto.

Reglas:

- La decisión final es la más fuerte de todas las reglas.
- `ask` pendiente, expirado, consumido o sin canal humano/de confianza = `deny`.
- `deny` no se convierte en salida informativa ni se rebaja a `allow`.
- Error, timeout o ausencia de un control crítico deniega esa operación; no toda
  la sesión. Diagnóstico y reparación seguros siguen disponibles.
- Un `after-hook` no deshace un efecto ni sustituye un control previo.

## 4. Aprobaciones

Una aprobación DEBE:

- ser emitida por un canal humano/host de confianza (TTY, UI de OpenCode o
  mecanismo administrado equivalente);
- estar vinculada a `{operación, recursos, cliente, proyecto, policyHash,
  contractVersion, nonce, expiresAt}`;
- ser de un solo uso;
- invalidarse si cambia el estado relevante;
- ser verificable antes del efecto.

NO DEBE aceptarse como aprobación:

- texto del modelo, del repo, de una nota o de un resultado de tool;
- `USER_REQUESTED_COMMIT`, `CHECKS_OK` ni metadatos equivalentes;
- “Allow always” sin vínculo a la operación/recursos actuales;
- una aprobación de otra versión, cliente, proyecto o conjunto de recursos.

Si no existe un canal de aprobación confiable, `ask` se resuelve como `deny`.
La aprobación no se pasa a procesos no autorizados ni se escribe en logs con
payloads.

## 5. Cobertura por frontera

La matriz completa está en `docs/security/operation-matrix.md`. Resumen:

- **Archivos/indexado:** raíces reales, symlinks/junctions, rutas indirectas,
  secretos fuera de contexto/CodeGraph.
- **Shell/procesos:** allowlist, entorno mínimo, timeouts, scripts y ejecución
  indirecta; el aislamiento de procesos/red es externo.
- **Git:** consentimiento real para stage/commit, escaneo de staged/outgoing,
  checks ligados a la revisión, controles previos a push/destructivas.
- **Memoria/documentación:** autorización por cliente/proyecto en toda operación,
  incluidos get por ID, brief/related, ancestros/global, búsqueda all/subtree,
  tree/rollup, promoción y administración. Un scope no es una ACL.
- **Persistencia/contexto:** clasificación/redacción antes de guardar, indexar,
  exportar, capturar subagentes o compactar.
- **Destructivas/versiones:** preview + respaldo + aprobación vinculada,
  revalidación antes del efecto y escrituras condicionales cuando existan.
- **Egress/modelo/red:** proveedores, endpoints, prompt/adjuntos,
  continuaciones, títulos, compactación, generación auxiliar, HTTP/WS, MCP,
  shell y fetch de Code Mode.
- **Integraciones/delegación:** herramienta MCP, argumentos y destino; skills,
  plugins e integridad; primario y especialistas con el mismo suelo.
- **Auditoría/reposo:** decisión, regla, operación, contexto autorizado y
  referencia de aprobación, sin payloads.

Invariantes:

- Estar fuera del repo o ignorado por Git no implica seguridad.
- Un nombre de evento declarado o un `hooks check` voluntario no prueba
  cobertura.
- Llamadas anidadas, scripts, Code Mode y herramientas alternativas DEBEN pasar
  por el mismo control; si no se puede mediar, se bloquea la capacidad sensible.

## 6. Mapeo V1/V2

### V2

- Autorización: `permission.hook("evaluate")` + permisos/políticas nativos.
- Argumentos antes del efecto: `tool.hook("execute.before")`.
- Entorno/tiempo de shell: `shell.hook("create.before")`; no reemplaza la
  autorización.
- Canales de sesión: `session.hook` para cada tipo/canal realmente soportado.
- `event`/after-hooks: auditoría y captura filtrada.

### V1 y otros harnesses

- Usar el adaptador equivalente solo si existe mediación suficiente.
- Si no existe, documentar la brecha y bloquear la capacidad sensible.
- No prometer paridad V1/V2 ni cobertura de un plugin que no cargó.
- La cobertura V1 completa queda en T-5.6.4; este contrato declara el requisito.

El contrato no inventa mecanismos de cancelación ni asume que el modelo puede
detener una operación ya iniciada. La autorización es previa al efecto.

## 7. Secretos, datos personales y clientes

- Antes de guardar, indexar, exportar, compactar o enviar contexto, DEBE
  clasificarse el contenido.
- Secretos, llaves, certificados, dumps y credenciales NO DEBEN entrar en
  contexto, memoria, CodeGraph, logs, auditoría ni modelo.
- Datos personales: minimización/anonimización o bloqueo según política.
- El dato detectado NO DEBE volcarse en el error, mensaje o log.
- Toda operación de memoria/documentación DEBE autorizar cliente y proyecto,
  incluso las indirectas.
- La recuperación relacionada/ancestros/global NO DEBE exponer otro cliente.
- Migrar toda la base (§5) no concede acceso a toda ella ni autoriza reescribir
  o eliminar el legado silenciosamente.
- La allowlist base de `~/.malahor/vault/**` no es permiso irrestricto.

## 8. Egress y modelo

- Proveedores, endpoints, identidad y transporte DEBEN estar aprobados.
- DEBE cubrirse prompt, adjuntos, continuaciones, títulos, compactación,
  generación auxiliar y canales HTTP/WebSocket.
- DEBE cubrirse MCP, shell y `fetch` de Code Mode.
- Un canal no mediable queda restringido; no se presume cubierto por un hook
  HTTP.
- No se selecciona ni detecta modelo automáticamente.
- El modelo no es autoridad de seguridad ni puede aprobar su propio egress.

## 9. Auditoría

Evento mínimo:

```jsonc
{
  "auditVersion": 1,
  "timestamp": "2026-10-21T00:00:00Z",
  "decision": "allow|warn|ask|deny",
  "event": "git.commit.before",
  "operation": "commit",
  "client": "cliente-a",
  "project": "proyecto-x",
  "policyVersion": "2026-10-21.1",
  "policyHash": "sha256:...",
  "ruleIds": ["..."],
  "approvalRef": "nonce/hash o null",
  "resourceRefs": ["hash/ruta normalizada, sin contenido"],
  "host": "wsl|linux|win32|darwin",
  "engineVersion": "..."
}
```

Requisitos:

- Sin payloads, secretos, credenciales, tokens ni datos personales.
- Referencias por hash/ruta normalizada, no contenido.
- Archivo local: `~/.malahor/audit/security.jsonl`, 0600, directorio 0700,
  append-only con rotación.
- Retención configurable; default 30 días o 10 archivos, el que ocurra primero.
- Si la política exige auditoría y no está disponible, la operación se deniega.
- 0600 no significa cifrado; cifrado/retención corporativa es un requisito de
  host que DEBE declararse.

## 10. Límites de host/SO/red

Malahor:

- NO ES una frontera de aislamiento ni una certificación bancaria.
- No puede garantizar aislamiento de procesos/red si el host no lo provee.
- No reescribe políticas administradas ajenas en V2.
- No autoriza operaciones productivas por un “go” al desarrollo.
- Entorno/destino desconocido no autoriza una acción sensible.
- `.sandbox` o un worktree no aíslan procesos, red ni credenciales.
- `doctor` informa cobertura, políticas, hashes y bloqueos; no certifica
  cumplimiento.

Requisitos de host que la política puede exigir:

- separación de cuenta/SO;
- cifrado de disco;
- control de egress de red;
- política administrada del host;
- protección contra manipulación del archivo de política/auditoría.

Si un requisito obligatorio no se puede verificar, las capacidades sensibles que
dependan de él se bloquean.

## 11. Doctor y evidencia

`doctor` DEBE reportar:

- contrato, schema y política efectiva: versión, hash, fuentes y procedencia;
- validez de la política corporativa y del override;
- cobertura declarada por operación y brechas V1/V2;
- disponibilidad de auditoría y de canal de aprobación;
- requisitos de host/SO/red declarados y no verificables;
- capacidades sensibles bloqueadas por falta de mediación.

`doctor` NO DEBE:

- certificar aislamiento, cumplimiento regulatorio ni aprobación bancaria;
- mostrar secretos, payloads o credenciales;
- declarar “seguro” un canal no medible;
- convertir un `hooks check` voluntario en prueba de cobertura.

## 12. Aceptación

### T-5.1.8

- Contrato, esquema y matriz revisados y versionados.
- Jerarquía y merge monótono sin ambigüedad.
- `off`, `--force`, `--yes`, perfiles y metadatos no rebajan el suelo.
- `ask` pendiente bloquea; fallo crítico deniega la operación.
- Matriz completa, incluyendo llamadas indirectas y Code Mode.
- Mapeo V1/V2 con brechas y bloqueos explícitos.
- Auditoría sin payloads y comportamiento si falta.
- Límites de host/SO/red declarados.

### T-5.1.3

- Política efectiva con versión/hash/procedencia.
- `profile off` no desactiva el suelo corporativo.
- `assertHooksAllowed` bloquea `ask` y `deny`.
- Aprobaciones vinculadas a operación/recursos/cliente/versión.
- Cobertura real en plugin/CLI/MCP; llamadas indirectas y Code Mode.
- Fallo cerrado y tests de regresión.

### T-5.5.5

- Datos sintéticos en sandbox.
- Sin fuga entre clientes.
- Sin efecto antes de aprobación.
- Denegación ante fallo crítico.
- Sin secretos en logs/modelo.
- After-hooks no se usan para deshacer filtraciones.
- Un `hooks check` voluntario no se confunde con cobertura.

## 13. Brechas actuales y migración

El contrato reemplaza gradualmente el comportamiento actual:

| Brecha actual | Requisito v1 |
|---|---|
| `profile: "off"` devuelve `allow` global | El suelo built-in/corporativo sigue activo; `off` solo desactiva controles opcionales |
| `assertHooksAllowed()` ignora `ask` | `ask` pendiente = `deny` |
| Política sin versión/hash/procedencia | Política efectiva versionada y hasheada |
| Merge local puede aflojar | Merge monótono; local solo endurece |
| Eventos voluntarios sin cobertura runtime | Matriz operación → punto de ejecución real |
| Sin auditoría de decisiones | Auditoría mínima sin payloads; fallo cerrado si es obligatoria |
| V1 sin permisos equivalentes | Adaptador o bloqueo de capacidad sensible |

Migración:

- Las políticas existentes se migran a v1 sin rebajar controles.
- Si una política no se puede mapear, se bloquean las capacidades sensibles y se
  informa; no se aplica un default más permisivo.
- Un cambio de contrato/schema incompatible requiere nueva versión mayor y aviso
  de `doctor`.

## 14. Versionado y cambios

- `contractVersion`: 1.
- `schemaVersion`: 1.
- Cambios incompatibles: nueva versión mayor; no se aceptan silenciosamente.
- Cambios compatibles: nueva versión menor del schema/documento, con hash.
- La política efectiva y la auditoría registran la versión/hash usados.
- Toda excepción operativa debe estar justificada, acotada y auditada; no puede
  convertir el suelo en opcional.
