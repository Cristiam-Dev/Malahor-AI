# malahor-ai

CLI local que potencia agentes de IA —OpenCode primero— con memoria persistente, contexto por proyecto, skills de especialidad propias, SDD y controles de calidad. Todo vive fuera de tus repos.

## Requisitos

- Node.js 22 o superior
- OpenCode instalado (primer agente soportado)
- WSL/Ubuntu como entorno principal; soporte para Linux nativo, macOS y Windows
- Opcional: Obsidian con el plugin "Local REST API" para documentacion

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

`install` configura OpenCode, instala los assets de Malahor y **aplica la politica de intervencion al final, solo tras validar** que Mnemo, comandos, compaction y recuperacion de contexto funcionan: si algo falla, el agente nunca queda bloqueado. `doctor --self-heal` repara instalaciones rotas y migra permisos antiguos. La politica activa vive en `opencode.jsonc`; tras cambiarla, abre una sesion nueva de OpenCode.

Malahor se distribuye como CLI para uso manual/asistido con OpenCode. No expone todavia una API publica estable ni funciona como SDK autonomo embebible dentro de otros proyectos.

## Comandos

| Comando | Descripcion |
|---|---|
| `malahor-ai install` | Instala Malahor en OpenCode (`--bootstrap`, `--policy-after <nivel>`) |
| `malahor-ai doctor` | Diagnostica la instalacion; `--self-heal` repara y migra permisos legacy |
| `malahor-ai git` | Flujo git asistido: precommit, prepush y mensajes de commit seguros |
| `malahor-ai hooks` | Guardrails cross-harness para git, secretos, memoria, instalacion y calidad |
| `malahor-ai context` | Nivel de contexto por proyecto y deteccion de stack |
| `malahor-ai memory` | Administra la memoria Mnemo |
| `malahor-ai obsidian` | Configura el puente Obsidian MCP |
| `malahor-ai update` | Refresca instalacion, assets y formato de politica |
| `malahor-ai uninstall` | Remueve Malahor de OpenCode, incluidos los bloqueos que escribio |

## Conceptos

- **Memoria**: decisiones, bugs, patrones, arquitectura y resumen de sesion en scopes jerarquicos `proyecto/asignacion/HU/area`, guardados por el backend activo fuera de los repos. La recuperacion hereda padres y `global`; `mem_brief` entiende solicitudes naturales y busca recuerdos relacionados en otros scopes.
- **Administracion segura de memoria**: el agente puede inspeccionar, respaldar, mover/reclasificar, borrar y restaurar memoria via MCP con preview + confirmacion (`mem_inspect_project`, `mem_backup`, `mem_move_preview`/`mem_move`, `mem_delete_project_preview`/`mem_delete_project`, `mem_restore_preview`/`mem_restore`).
- **Contexto por proyecto**: clave canonica, root activo, memoria y documentacion opcional, con estado guardado fuera del repo. Los valores persistidos por versiones anteriores siguen siendo legibles hasta su migracion asistida.
- **Obsidian (opcional)**: documentacion humana via Obsidian MCP; nunca por filesystem directo. Soporta OpenCode en WSL con Obsidian en Windows y Windows nativo.
- **Politica de intervencion**: `ejecutar`, `guiar` o `acompanar`, aplicada al final de la instalacion. `guiar` y `acompanar` usan una lista blanca de comandos (no un bloqueo total): el agente conserva siempre la ruta de diagnostico y autorreparacion, y `install`/`update` solo piden confirmacion al usuario.
- **Bootstrap agent-safe**: `install --bootstrap` construye `dist/` automaticamente si falta y valida todo antes de tocar permisos.
- **Hooks cross-harness**: reglas internas de Malahor independientes de OpenCode para bloquear secretos, git destructivo, memoria destructiva sin preview, politica insegura y pushes sin checks. Se invocan por CLI (`malahor-ai hooks check ...`) o MCP (`malahor_hook_check`).
- **Perfiles de hooks**: `off`, `light`, `standard`, `strict`, `release`, configurables fuera del repo en `~/.malahor/policies/default.jsonc` y `~/.malahor/policies/projects/<proyecto>.jsonc`.
- **Git asistido**: `malahor-ai git precommit`, `prepush` y `commit-message` ejecutan los guardrails y proponen el comando seguro sin hacer `git add`, `commit` ni `push` por ti.
- **Consentimiento git**: `git add` y `git commit` quedan bloqueados por hooks si no hay una orden explicita de stage/commit; "continuar" o "cerrar fase" no cuentan como autorizacion.
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

Malahor no deja archivos dentro de tus repos. Configuracion, memoria, backups y assets viven en `~/.malahor/`.

## Ejemplos

```bash
# Ver el nivel de contexto del proyecto y el stack detectado
malahor-ai context status
malahor-ai context detect

# Recuperar o guardar una capsula corta de contexto
malahor-ai context recover
malahor-ai context save "objetivo, estado, decisiones y proximo paso"

# Revisar la memoria del proyecto
malahor-ai memory list
malahor-ai memory inspect <proyecto>

# Guardrails antes de acciones sensibles (portable a cualquier harness)
malahor-ai hooks status
malahor-ai hooks profile set release --project malahor
malahor-ai hooks check git.commit.before
malahor-ai hooks check git.push.before --profile release --confirm CHECKS_OK
malahor-ai hooks check git.reset.before --command "git reset --hard"

# Flujo git asistido (no ejecuta commit/push)
malahor-ai git commit-message agrega flujo git asistido --type feat --scope hooks
malahor-ai git precommit --message "✨ feat(hooks): agrega flujo git asistido"
malahor-ai git prepush --confirm CHECKS_OK

# Validar acciones git reales solo con consentimiento explicito
malahor-ai hooks check file.stage.before --command "git add README.md" --confirm USER_REQUESTED_STAGE
malahor-ai hooks check git.commit.before --command "git commit -m '✨ feat(hooks): agrega flujo git asistido'" --confirm USER_REQUESTED_COMMIT

# Configurar el puente Obsidian (modo automatico: wsl-windows o windows-local)
malahor-ai obsidian status
malahor-ai obsidian guide
malahor-ai obsidian setup
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

Tambien puedes escribir “recuperar contexto”, “guardar contexto”, “commit” o “comitea” y el agente debe aplicar el mismo protocolo. “Commit” o “comitea” disparan el flujo verificado: status/diff, diagnostico, testing y build; si algo falla, no se commitea. `/malahor-commit` nunca hace push.

Para trabajar en una asignacion grande, describe el proyecto, la asignacion, la HU o el area en lenguaje natural; el agente consulta la memoria por MCP y no necesitas escribir scopes ni usar comandos CLI.

Los comandos destructivos de memoria requieren confirmacion fuerte:

```bash
malahor-ai memory reset <proyecto> --yes --confirm <proyecto>
malahor-ai memory restore <backup> --yes --confirm RESTORE
```

## Troubleshooting

- El agente no puede editar ni ejecutar (instalacion o politica rotas): escribe `repara malahor` o `/malahor-reparar` en OpenCode; funciona aunque el agente este bloqueado porque la capsula corre con permisos del cliente.
- `doctor` reporta fallos criticos: `malahor-ai doctor --self-heal` y luego `malahor-ai install --bootstrap --yes`.
- Permisos legacy con bloqueo total (versiones previas a 4.10): `doctor --self-heal` los migra a la lista blanca agent-safe.
- Obsidian no conecta desde WSL: permite los puertos 27123 y 27124 en el Firewall de Windows y verifica el plugin "Local REST API".
- Cambiaste de politica y no surte efecto: abre una sesion nueva de OpenCode (o cambia de agente con Tab) para recargar `opencode.jsonc`.
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
