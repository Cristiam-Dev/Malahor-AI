# malahor-ai

CLI neutro de IA para desarrolladores. Se instala globalmente y potencia agentes como OpenCode, Claude Code, Cursor y Codex con memoria persistente, mapa estructural del codigo, orquestacion por subagentes, SDD y controles de calidad.

## Estado

Construccion inicial iniciada. La Fase 1 ya tiene scaffold npm, CLI minimo, Mnemo MCP, instalador OpenCode y sandbox de desarrollo para no tocar el entorno manual actual.

## Principio central

Malahor no debe dejar archivos dentro de los repos del usuario. Toda la configuracion, memoria, grafos, backups y assets viven fuera del proyecto, principalmente en `~/.malahor/`.

## Paquete

- Nombre npm: `malahor-ai`
- Distribucion: npm publico
- Lenguaje: TypeScript
- CLI: Bun compilado
- Memory server: Node 22 LTS + MCP + JSON storage

## Desarrollo seguro

Para probar sin sobrescribir `~/.malahor` ni `~/.config/opencode` reales:

```bash
bun run dev:sandbox
```

Esto usa rutas aisladas dentro del repo:

```text
.sandbox/home/.malahor
.sandbox/home/.config/opencode
```

Para diagnosticar el sandbox:

```bash
bun run doctor:sandbox
```

Para limpiar el sandbox:

```bash
bun run sandbox:reset
```

El entorno real solo debe tocarse cuando el flujo sandbox ya este validado.

## Comandos actuales

```bash
bun run build
bun run src/cli/index.ts install --dry-run --yes
bun run src/cli/index.ts doctor
bun run src/cli/index.ts memory list
bun run src/cli/index.ts memory inspect malahor
bun run src/cli/index.ts memory backup --dry-run
bun run src/cli/index.ts memory reset malahor --dry-run
bun run src/cli/index.ts memory restore path/to/db.json.backup.bak --dry-run
bun run src/cli/index.ts obsidian status
MALAHOR_OBSIDIAN_API_KEY=... bun run src/cli/index.ts obsidian setup --yes
```

Los comandos destructivos de memoria requieren confirmacion fuerte:

```bash
malahor-ai memory reset <project> --yes --confirm <project>
malahor-ai memory reset --all --yes --confirm ALL
malahor-ai memory restore <backup-file> --yes --confirm RESTORE
```

`restore` solo acepta backups dentro de `~/.malahor/backups`.

Para integrar Obsidian con OpenCode, en dos escenarios:

```bash
malahor-ai obsidian status
malahor-ai obsidian guide
malahor-ai obsidian setup
malahor-ai obsidian verify
```

Modos soportados (deteccion automatica, override con `--mode`):

- `wsl-windows`: OpenCode en WSL + Obsidian en Windows. Genera `~/.malahor/scripts/mcp-obsidian.sh` y guarda la API key en `~/.malahor/secrets/obsidian.env`.
- `windows-local`: OpenCode y Obsidian nativos en Windows. Genera `%USERPROFILE%\.malahor\scripts\mcp-obsidian.ps1` y guarda la API key en `%USERPROFILE%\.malahor\secrets\obsidian.ps1`.

El setup registra el MCP `obsidian` en OpenCode y fuerza `permission.external_directory = "deny"`.

## Contexto por proyecto

Cada proyecto define un nivel de contexto guardado fuera del repo en `~/.malahor/projects.json`, con la clave canonica como llave:

```bash
malahor-ai context status
malahor-ai context set mnemo+graphify+obsidian
malahor-ai context obsidian on
malahor-ai context obsidian off
malahor-ai context graphify on
malahor-ai context graphify off
```

Niveles soportados:

- `mnemo`: solo memoria Mnemo.
- `mnemo+graphify`: Mnemo + Graphify (default para proyectos nuevos).
- `mnemo+graphify+obsidian`: suma Obsidian MCP para documentacion humana.

Reglas: Mnemo siempre esta activo; Obsidian requiere Graphify; Graphify off deshabilita tambien Obsidian. Con `--project <key>` se opera sobre otro proyecto sin cambiar el directorio actual, y `--dry-run` muestra el cambio sin escribir.

## Skills first-party

Malahor incluye skills de especialidad propias en `assets/skills/`: backend, frontend, devops, diseno e integracion de IA, con un router (`specialty.md`) que selecciona la skill correcta segun el stack detectado:

```bash
malahor-ai context detect
```

El detector lee manifiestos del proyecto (`package.json`, `pom.xml`, `pyproject.toml`, `go.mod`, `Dockerfile`, workflows) y sugiere las skills aplicables. Malahor no depende de skills externas instaladas en la maquina: las externas son complementarias y opcionales.
