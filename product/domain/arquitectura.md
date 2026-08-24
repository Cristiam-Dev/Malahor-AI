# Arquitectura - malahor-ai

## Decision base

`malahor-ai` se construye como CLI npm publico en TypeScript. El CLI instala y configura un ecosistema local en `~/.malahor/`, con Mnemo como MCP server de memoria, Graphify como mapa estructural del codigo y assets markdown para orquestacion, skills y SDD.

## Stack tecnico

| Componente | Tecnologia |
|---|---|
| CLI | TypeScript + Bun |
| Binario CLI | `bun build --compile` |
| Memory server | Node 22 LTS + TypeScript |
| Protocolo memoria | MCP via stdio |
| Storage memoria | JSON puro en `~/.malahor/mnemo/db.json` |
| Package manager | pnpm workspaces |
| Assets | Markdown puro |
| Prompts CLI | `@clack/prompts` |
| Validacion | `zod` |
| Code graph | `graphifyy` via Python/pip |

## Componentes principales

### CLI

Entry point: `src/cli/index.ts`.

Responsabilidades:

- Resolver comando (`install`, `doctor`, `uninstall`, `update`).
- Detectar entorno y agentes instalados.
- Ejecutar backups antes de modificar configuraciones.
- Instalar Mnemo y assets.
- Configurar MCP en el agente detectado.
- Reportar estado final y siguientes pasos.

### Mnemo

MCP server propio para memoria persistente entre sesiones.

Responsabilidades:

- Guardar observaciones por proyecto.
- Buscar contexto historico por keywords, tipo y proyecto.
- Guardar resumen de sesiones.
- Bloquear contenido sensible antes de persistirlo.

Storage inicial:

```ts
interface DB {
  observations: Observation[]
  sessions: Session[]
  nextId: number
}

interface Observation {
  id: number
  project: string
  type: 'decision' | 'bug' | 'pattern' | 'architecture' | 'learning' | 'general'
  title: string
  content: string
  tags: string
  created_at: string
}

interface Session {
  project: string
  summary: string
  created_at: string
}
```

Herramientas MCP:

- `mem_save`
- `mem_search`
- `mem_get`
- `mem_context`
- `mem_session_summary`
- `mem_list_projects`

### Graphify externo

Los grafos de codigo se generan fuera del repositorio del usuario:

```bash
GRAPHIFY_OUT=~/.malahor/graphs/$PROJECT graphify .
```

Regla inamovible: nunca escribir grafos dentro del repo objetivo.

### Orquestador OPENCODE.md

Archivo instalado en `~/.config/opencode/OPENCODE.md`.

Responsabilidades:

- Detectar proyecto activo automaticamente.
- Cargar memoria con Mnemo al inicio de sesion.
- Usar Graphify antes de leer archivos raw para orientacion.
- Delegar trabajo pesado a subagentes.
- Aplicar SDD en cambios no triviales.
- Guardar decisiones, patrones y cierres de sesion en memoria.

### SDD

Flujo de especificacion integrado:

1. `sdd-init`
2. `sdd-explore`
3. `sdd-propose`
4. `sdd-spec`
5. `sdd-design`
6. `sdd-tasks`
7. `sdd-apply`
8. `sdd-quality`
9. `sdd-verify`
10. `sdd-archive`

La fase `sdd-quality` es obligatoria y diferencia a Malahor: pruebas, cobertura, duplicados y preparacion SonarQube.

## Rutas

```ts
const PATHS = {
  malahor: '~/.malahor',
  mnemo: '~/.malahor/mnemo',
  graphs: '~/.malahor/graphs',
  vault: '~/malahor/vault',
  opencodeDir: '~/.config/opencode',
  opencodeJsonc: '~/.config/opencode/opencode.jsonc',
  opencodemd: '~/.config/opencode/OPENCODE.md',
}
```

## Configuracion critica de MCP en OpenCode

OpenCode requiere esta forma exacta:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mnemo": {
      "type": "local",
      "command": ["node", "/home/user/.malahor/mnemo/index.js"],
      "enabled": true
    }
  }
}
```

Errores que deben evitarse:

- `command` como string.
- ausencia de `enabled`.
- `type: "stdio"` en lugar de `type: "local"`.

## Decisiones cerradas

- Nombre del paquete npm: `malahor-ai`.
- OpenCode es el primer agente soportado.
- Claude Code, Cursor y Codex quedan despues del MVP base.
- WSL/Ubuntu es la plataforma prioritaria.
- Windows PowerShell, Linux y Mac se soportan en fases posteriores.
- No existen perfiles fijos; el orquestador infiere contexto dinamicamente.
- Vault markdown externo es compatible con Obsidian, pero opcional.
- Privacidad 100% local por defecto.
