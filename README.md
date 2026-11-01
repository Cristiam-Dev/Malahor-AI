# malahor-ai

CLI local que potencia agentes de IA —OpenCode primero— con memoria persistente, documentacion Markdown externa, contexto por proyecto, skills de especialidad propias, SDD y controles de calidad. Los datos operativos viven fuera de tus repos.

## Requisitos

- Node.js 22 o superior
- OpenCode instalado (primer agente soportado)
- WSL/Ubuntu como entorno principal; soporte para Linux nativo, macOS y Windows
- Opcional: Obsidian, VSCode u otro lector Markdown para editar manualmente el vault

## Instalacion

La via recomendada no requiere consola: abre OpenCode y escribe `instala malahor`. El agente ejecuta el bootstrap agent-safe completo y solo te pedira confirmar si algo toca configuracion.

Si prefieres terminal, una sola linea cuando el paquete este publicado en npm:

```bash
npm install -g malahor-ai && malahor-ai install --bootstrap --yes
```

## Quickstart

```bash
malahor-ai install --bootstrap --yes
malahor-ai doctor
```

`install` configura OpenCode, instala los assets de Malahor, registra los MCP de memoria y documentacion y **aplica la politica de intervencion al final, solo tras validar** sus capacidades: si algo falla, el agente nunca queda bloqueado. En TTY, el alta de un proyecto ofrece el vault gestionado recomendado o una carpeta externa; `--yes` y los procesos no interactivos usan el gestionado salvo `--docs-path` explicito. `doctor --self-heal` repara instalaciones rotas y migra permisos antiguos. El modo activo vive en la configuracion de Malahor y sus cambios aplican desde el siguiente turno de la misma sesion.

Malahor se distribuye como CLI para uso manual/asistido con OpenCode. No expone todavia una API publica estable ni funciona como SDK autonomo embebible dentro de otros proyectos.

## Comandos

| Comando | Descripcion |
|---|---|
| `malahor-ai install` | Instala Malahor en OpenCode (`--bootstrap`, `--policy-after <nivel>`, `--docs-path <externa>`) |
| `malahor-ai doctor` | Diagnostica la instalacion; `--self-heal` repara y migra permisos legacy |
| `malahor-ai git` | Flujo Git local-only: precommit, mensajes y fallback seguro de commit |
| `malahor-ai hooks` | Guardrails cross-harness para git, secretos, memoria, instalacion y calidad |
| `malahor-ai context` | Nivel por proyecto, deteccion de stack y migracion asistida de niveles legacy |
| `malahor-ai codegraph` | Contexto estructural con symgraph e indice gestionado fuera del repo (`status`, `setup`, `index`, `guide`) |
| `malahor-ai docs` | Resuelve, inicializa, valida y abre el vault; configura su cliente humano |
| `malahor-ai memory` | Administra la memoria Mnemo |
| `malahor-ai update` | Refresca instalacion, assets y formato de politica |
| `malahor-ai uninstall` | Remueve Malahor de OpenCode, incluidos los bloqueos que escribio |

## Conceptos

- **Memoria**: decisiones, bugs, patrones, arquitectura y resumen de sesion en scopes jerarquicos `proyecto/asignacion/HU/area`, guardados por el backend activo fuera de los repos. La recuperacion hereda padres y `global`; `mem_brief` entiende solicitudes naturales y busca recuerdos relacionados en otros scopes.
- **Administracion segura de memoria**: el agente puede inspeccionar, respaldar, mover/reclasificar, borrar y restaurar memoria via MCP con preview + confirmacion (`mem_inspect_project`, `mem_backup`, `mem_move_preview`/`mem_move`, `mem_delete_project_preview`/`mem_delete_project`, `mem_restore_preview`/`mem_restore`).
- **Contexto por proyecto**: `memory` o `memory+codegraph` (predeterminado para proyectos nuevos). El orden es proyecto canonico → memoria → CodeGraph habilitado y gestionado → `docs_*` → lecturas dirigidas de codigo. La documentacion externa no depende del nivel. Los valores `+obsidian` y `mnemo*` permanecen legibles por compatibilidad; Obsidian ya no habilita storage/contexto y los niveles `mnemo*` no activan CodeGraph hasta `context migrate --apply`. La migracion previsualiza, respalda, publica atomicamente, verifica y revierte ante fallo; no instala ni indexa CodeGraph.
- **Contexto estructural**: symgraph 2026.10.18 (Rust/tree-sitter) sustituye al proveedor CodeGraph que solo admite indices locales. Malahor fija SHA-256 de release, ejecutable y puente MCP, indexa en `MALAHOR_HOME/codegraph/indexes/` y solo registra herramientas de lectura para indices gestionados y nivel nuevo con codigo. `symgraph-reindex` no se expone: reindexa exclusivamente mediante el CLI con nuevo consentimiento. `install --yes` no instala ni indexa automaticamente; `doctor` avisa y degrada sin bloquear. Tras cambiar niveles o assets gestionados, abre una sesion nueva de OpenCode.
- **Vault documental canonico**: Markdown UTF-8 bajo `MALAHOR_HOME/vault/projects/<clave-canonica>/`, o un override externo en `projects.json.docs.path`. Los agentes usan exclusivamente el MCP first-party `docs` con ocho operaciones cerradas (`resolve`, `list`, `read`, `search`, `write`, `append`, `move`, `open`), paths relativos, SHA-256, escrituras condicionales y publicacion atomica; nunca filesystem directo, Obsidian MCP ni fallback al repo.
- **Fachada natural**: pide “busca la decision de autenticacion”, “actualiza el roadmap”, “crea un ADR” o “abre la arquitectura”. El agente infiere proyecto y area, busca antes de crear, gestiona versiones y solo aclara ambiguedades reales. No necesitas conocer claves, rutas internas, SHA ni nombres de tools. No existe borrado permanente: una eliminacion se resuelve como archivo/movimiento.
- **Cliente humano global**: `docs.client` admite `system`, `vscode` u `obsidian`; `system` es el default. La precedencia es `--app` → preferencia global → `system`. En Windows/WSL, Malahor convierte rutas en ambos sentidos y abre clientes Windows sin API keys, Local REST API, MCP de Obsidian ni wrappers `.sh`/`.ps1`. Si un cliente no abre, degrada visiblemente al explorador del sistema.
- **Frontera documental del repo**: Markdown se bloquea por defecto salvo README, licencias, gobernanza publica, assets gestionados, ejemplos y fixtures. Los contratos machine-readable permanecen permitidos. El flujo Git verificado rechaza documentacion operativa staged.
- **Politica de intervencion**: `ejecutar`, `guiar` o `acompanar`, aplicada al final de la instalacion. `guiar` y `acompanar` usan una lista blanca de comandos (no un bloqueo total): el agente conserva siempre la ruta de diagnostico y autorreparacion, y `install`/`update` solo piden confirmacion al usuario.
- **Plan de Malahor (estado V4 sobre OpenCode V2)**: una unica configuracion `execution.intervention`: `acompanar`=asesor, `guiar`=asistente y `ejecutar`=ejecutor. El campo `mode` heredado solo sirve de fallback si no existe intervention; si discrepan, manda intervention. El nucleo liga `planID`, revision, digest, proyecto, sesion, revision de politica, presentacion humana, efectos exactos y estado; la autorizacion ya no caduca por reloj. `malahor_plan` usa divulgacion progresiva: la vista principal resume objetivo, resultado, hasta cinco pasos, impacto agrupado, riesgo y accion requerida; el anexo tecnico conserva exclusiones, criterios, dependencias, rutas, comandos, digest y efectos exactos. Un riesgo alto o una categoria critica de seguridad, datos, arquitectura o destruccion abre el anexo por defecto. `/malahor-plan detalles` (o `details`) ofrece la vista tecnica expandida aunque el cliente no soporte desplegables. El primario copia el Markdown exactamente una vez como mensaje normal en foreground y termina el turno: la traza o el output tecnico del tool en background no cuentan como presentacion. Solo una solicitud posterior (`go`, `implementa` o equivalente) permite `malahor_run`. El mismo renderer representa revision, aprobacion y controles sin cambiar la identidad firmada. En asistente se mantienen revision y ejecucion como confirmaciones distintas; en ejecutor hay una aprobacion posterior al plan; asesor solo presenta concepto. `malahor_plan_control` y `/malahor-plan` permiten consultar, pausar, reanudar, revocar y completar. Las dependencias bloquean sin heredar permisos ni arrancar automaticamente. Una revision material o un cambio de proyecto, modo o politica invalida la autorizacion anterior. Los estados V3 y anteriores fallan cerrado. La autorizacion del plan no sustituye guardrails de Git, secretos, memoria, instalacion o datos reales.
- **Cambio de modo**: `malahor-ai mode status`, `malahor-ai mode preview <asesor|asistente|ejecutor>` y `malahor-ai mode set <modo>`; la CLI pide confirmacion TTY o acepta `--yes`. En OpenCode V2, `/malahor-modo <modo>` muestra una confirmacion nativa; `status` y `preview <modo>` son informativos. No se copia ni se muestra ningun token: una version optimista interna detecta cambios concurrentes. La aplicacion revisa hooks, crea un respaldo si habia archivo, conserva las demas claves/comentarios JSONC y renueva `execution.revision`, por lo que invalida todos los planes anteriores aunque despues se vuelva al modo previo. El modo nuevo aplica desde el siguiente turno de la misma sesion.
- **Limite de seguridad de la UI**: una respuesta de permiso de OpenCode es una decision del cliente que tambien puede emitirse mediante su API. Esta implementacion ofrece aprobaciones practicas visibles, **no atestacion criptografica del origen humano**. La autorizacion persistente se limita a la revision y acciones declaradas y no concede nuevos permisos del host. El recibo HMAC protege integridad local, no identidad. Las aprobaciones sensibles siguen siendo independientes, puntuales y sujetas a sus TTL/guardrails. No usar la UI como unico control cuando se exija identidad atestada.
- **Bootstrap agent-safe**: `install --bootstrap` construye `dist/` automaticamente si falta y valida todo antes de tocar permisos.
- **Hooks cross-harness**: reglas internas de Malahor independientes de OpenCode para bloquear secretos, Git remoto, destruccion local sin preview, memoria destructiva y politica insegura. Se invocan por CLI (`malahor-ai hooks check ...`) o MCP (`malahor_hook_check`).
- **Perfiles de hooks**: `off`, `light`, `standard`, `strict`, `release`, configurables fuera del repo en `~/.malahor/policies/default.jsonc` y `~/.malahor/policies/projects/<proyecto>.jsonc`.
- **Git local-only**: `push`, `pull`, `fetch`, `clone`, `ls-remote`, `remote update`, submodulos remotos y equivalentes son hard DENY, incluso dentro de shells o sustituciones indirectas. Ningun perfil, plan, confirmacion, nonce o fallback los habilita; `prepush` ya no existe. Mutadores locales no modelados fallan cerrado.
- **Consentimiento Git local**: `comitea` o `/malahor-commit` autorizan, tras gates verdes, stage exclusivo de rutas revisadas y commit ordinario mediante una intencion estructurada de un solo uso, sin tokens humanos ni confirmacion redundante. Metadata o confirmaciones legacy no sustituyen esa evidencia. Amend, reset, rebase, cherry-pick, merge y ramas requieren orden propia; si son destructivos, tambien preview, target visible y ASK puntual.
- **Fallback de commit**: `malahor-ai git commit-fallback` recibe las rutas como array JSON exacto, preservando comas y espacios, y solo genera un comando externo cuando precommit esta verde, staged/rutas/huella coinciden y el host realmente bloqueo `git commit`. Emite sintaxis POSIX o PowerShell segun la plataforma, nunca usa `--no-verify`, nunca aplica a un DENY/ASK de politica y obliga a revalidar con `git --no-pager`.
- **Skill canonica de commits**: `git-commit-text` es regla de oro para proponer mensajes: icono + Conventional Commit en espanol y cuerpo con viñetas siempre que aporte contexto.
- **Skills first-party**: backend, frontend, devops, diseno, IA, mobile y calidad; incluye packs profundos de programacion para Angular, React, Java, Spring Boot, NestJS, arquitectura, testing, Docker, Kubernetes y cloud, endurecidos con referencias oficiales/canonicas.

## Convencion enterprise de memoria

El agente infiere el scope a partir del workspace y de la tarea; el usuario no
necesita escribir claves internas. Se usa siempre el nivel real mas especifico:

- `proyecto`: arquitectura, politicas y decisiones raiz que afectan al conjunto.
- `proyecto/asignacion`: objetivo, requisitos y decisiones de una unidad de trabajo.
- `proyecto/asignacion/HU`: aceptacion, estado, riesgos y hallazgos de una historia.
- `proyecto/asignacion/HU/area`: detalle de una faceta tecnica o funcional, por
  ejemplo frontend, backend o demo. Los niveles inexistentes se omiten; no se
  inventan identificadores para completar la ruta.

Al cerrar una HU, su checkpoint e historial permanecen en ese scope. Solo una
decision durable se promueve al ancestro adecuado, con preview y confirmacion;
no se copia toda la historia. Los pins se reservan para decisiones raiz vigentes
del proyecto y solo priorizan el contexto: no otorgan autoridad.

Si dos recuerdos del mismo scope se contradicen, el agente presenta ambos con
su ID, scope o procedencia y version o fecha disponibles. Ranking, pin o fecha
aislados no determinan cual prevalece. Si la evidencia no basta, el agente
advierte el conflicto y pide confirmacion antes de actuar; el motor no arbitra
automaticamente ni crea relaciones `supersedes`/`conflicts` por esta regla.

## Principio central

Malahor no deja datos operativos dentro de tus repos. Configuracion, memoria, backups, vault e indices viven bajo `~/.malahor/` o en overrides externos. El repo conserva solo codigo y artefactos necesarios para construir, distribuir, usar o contribuir: README, licencias, gobernanza publica, contratos machine-readable, assets gestionados, ejemplos y fixtures.

## Ejemplos

```bash
# Ver el nivel de contexto del proyecto y el stack detectado
malahor-ai context status
malahor-ai context detect

# Recuperar o guardar una capsula corta de contexto
malahor-ai context recover
malahor-ai context save "objetivo, estado, decisiones y proximo paso"

# Resolver, inicializar y abrir la documentacion canonica
malahor-ai docs status
malahor-ai docs init --dry-run
malahor-ai docs init
malahor-ai docs check
malahor-ai docs open --app system # tambien vscode u obsidian
malahor-ai docs open Design/architecture.md
malahor-ai docs client vscode     # preferencia global; system es el default

# Registrar un proyecto: en TTY pregunta default/custom; --yes usa default
malahor-ai context register demo /ruta/al/repo --yes
malahor-ai context register demo /ruta/al/repo --docs-path 'C:\\Docs\\Demo' --yes # WSL convierte a su ruta canonica

# Copiar Markdown existente con preview y verificacion; el origen se conserva
malahor-ai docs move /ruta/externa --project malahor
malahor-ai docs move /ruta/externa --project malahor --apply --yes

# Previsualizar y aplicar la conversion reversible de niveles mnemo* heredados
malahor-ai context migrate
malahor-ai context migrate --apply --yes

# Previsualizar antes de consentir descarga e indexado (solo proyecto registrado)
malahor-ai codegraph guide
malahor-ai codegraph status
malahor-ai codegraph setup --dry-run
malahor-ai codegraph setup --confirm INSTALL_SYMGRAPH
malahor-ai codegraph index --dry-run
malahor-ai codegraph index --project demo --confirm INDEX_SYMGRAPH:demo # sustituye demo por la clave canonica

# Revisar la memoria del proyecto
malahor-ai memory list
malahor-ai memory inspect <proyecto>

# Guardrails antes de acciones sensibles (portable a cualquier harness)
malahor-ai hooks status
malahor-ai hooks profile set release --project malahor
malahor-ai hooks check git.commit.before --command "git commit -m '✨ feat(hooks): agrega flujo local'" --intent commit
malahor-ai hooks check git.push.before --command "git push" # siempre DENY
malahor-ai hooks check git.reset.before --command "git reset --hard HEAD~1" --intent reset

# Flujo Git local asistido
malahor-ai git commit-message agrega flujo git asistido --type feat --scope hooks
malahor-ai git precommit --message "✨ feat(hooks): agrega flujo git asistido"

# Propagar una orden explicita de commit sin pedir otra confirmacion
malahor-ai hooks check file.stage.before --command "git add -- README.md" --paths README.md --intent commit
malahor-ai hooks check git.commit.before --command "git commit -m '✨ feat(hooks): agrega flujo git asistido'" --paths README.md --intent commit

```

En OpenCode, Malahor instala comandos slash equivalentes:

- `/recuperar-contexto`
- `/malahor-contexto`
- `/guardar-contexto`
- `/compactar-seguro`
- `/malahor-bootstrap`
- `/malahor-doctor`
- `/malahor-reparar`
- `/malahor-commit`

Tambien puedes escribir “recuperar contexto”, “guardar contexto”, “commit” o “comitea” y el agente debe aplicar el mismo protocolo. “Commit” o “comitea” disparan status/diff, diagnostico, testing y build; si todo pasa, autorizan stage exacto y commit local sin otra pregunta. `/malahor-commit` nunca contacta un remoto. Si el host bloquea un commit ya verificado, entrega un fallback externo exacto y revalida despues.

Para trabajar en una asignacion grande, describe el proyecto, la asignacion, la HU o el area en lenguaje natural; el agente consulta memoria y documentacion por MCP y no necesitas escribir scopes, rutas, versiones ni comandos CLI.

Los comandos destructivos de memoria requieren confirmacion fuerte:

```bash
malahor-ai memory reset <proyecto> --yes --confirm <proyecto>
malahor-ai memory restore <backup> --yes --confirm RESTORE
```

## Troubleshooting

- El agente no puede editar ni ejecutar (instalacion o politica rotas): escribe `repara malahor` o `/malahor-reparar` en OpenCode; funciona aunque el agente este bloqueado porque la capsula corre con permisos del cliente.
- `doctor` reporta fallos criticos: `malahor-ai doctor --self-heal` y luego `malahor-ai install --bootstrap --yes`.
- Permisos legacy con bloqueo total (versiones previas a 4.10): `doctor --self-heal` los migra a la lista blanca agent-safe.
- `docs open --app obsidian` abre el cliente Windows desde WSL mediante `wslpath`; si Obsidian aun no conoce la carpeta, abre una vez `malahor-ai docs path` como vault. No requiere puente MCP, API key ni Local REST API.
- Cambiaste el modo: se aplica desde el siguiente turno de la sesion actual. Si una actualizacion de assets o capacidades no aparece, ejecuta `/reload` y revisa `malahor-ai doctor`.
- En Windows, Malahor detecta la carpeta real de OpenCode V2 con `opencode api get /api/config`; si necesitas forzar otra ruta, usa `MALAHOR_OPENCODE_DIR`.
- Para probar sin tocar el entorno real: scripts sandbox de la seccion Desarrollo.

## Desarrollo

```bash
bun install        # dependencias
bun run build      # compila a dist/
bun run dev:sandbox      # instalacion en rutas aisladas .sandbox/
bun run doctor:sandbox   # diagnostico del sandbox
bun run context:sandbox  # contexto del sandbox
bun run sandbox:reset    # limpiar sandbox
```

El sandbox usa `.sandbox/home/.malahor` y `.sandbox/home/.config/opencode` para no tocar `~/.malahor` ni `~/.config/opencode` reales.

## Licencia

Software propietario. Todos los derechos reservados. Ver `LICENSE`.

El paquete puede distribuirse por npm publico para facilitar la instalacion, pero eso no concede una licencia open-source ni permisos de uso, copia, modificacion o redistribucion sin autorizacion escrita del titular de derechos.
