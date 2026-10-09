# malahor-ai

CLI local que potencia agentes de IA —OpenCode primero— con memoria persistente, contexto por proyecto, mapa estructural del codigo, skills de especialidad propias, SDD y controles de calidad. Todo vive fuera de tus repos.

## Requisitos

- Node.js 22 o superior
- OpenCode instalado (primer agente soportado)
- WSL/Ubuntu como entorno principal; soporte para Linux nativo, macOS y Windows
- Opcional: Python + Graphify para el mapa de codigo (`pip install graphifyy`)
- Opcional: Obsidian con el plugin "Local REST API" para documentacion

## Instalacion

```bash
npm install -g malahor-ai
```

## Quickstart

```bash
malahor-ai install --yes
malahor-ai doctor
```

`install` configura OpenCode, instala los assets de Malahor, pregunta el nivel de intervencion (`ejecutar`, `guiar` o `acompanar`) y deja todo listo. `doctor` diagnostica la instalacion y muestra el proyecto activo y su nivel de contexto.

## Comandos

| Comando | Descripcion |
|---|---|
| `malahor-ai install` | Instala Malahor en OpenCode |
| `malahor-ai doctor` | Diagnostica la instalacion actual |
| `malahor-ai graph` | Genera mapa de codigo con Graphify, fuera del repo |
| `malahor-ai context` | Nivel de contexto por proyecto y deteccion de stack |
| `malahor-ai memory` | Administra la memoria Mnemo |
| `malahor-ai obsidian` | Configura el puente Obsidian MCP |
| `malahor-ai update` | Refresca instalacion y assets |
| `malahor-ai uninstall` | Remueve Malahor de OpenCode |

## Conceptos

- **Memoria (Mnemo)**: decisiones, bugs, patrones, arquitectura y resumen de sesion por proyecto, guardados en `~/.malahor/mnemo/`.
- **Contexto por proyecto**: niveles `mnemo`, `mnemo+graphify` (default) y `mnemo+graphify+obsidian`, guardados en `~/.malahor/projects.json` por clave canonica.
- **Graphify**: contexto tecnico del codigo, escrito siempre fuera del repo, en `~/.malahor/graphs/<proyecto>`.
- **Obsidian (opcional)**: documentacion humana via Obsidian MCP; nunca por filesystem directo. Soporta OpenCode en WSL con Obsidian en Windows y Windows nativo.
- **Politica de intervencion**: `ejecutar`, `guiar` o `acompanar`, elegida en la instalacion y reconfigurable.
- **Skills first-party**: backend, frontend, devops, diseno, IA, mobile y calidad; incluye packs profundos de programacion para Angular, React, Java, Spring Boot, NestJS, arquitectura, testing, Docker, Kubernetes y cloud, endurecidos con referencias oficiales/canonicas.

## Principio central

Malahor no deja archivos dentro de tus repos. Configuracion, memoria, grafos, backups y assets viven en `~/.malahor/`.

## Ejemplos

```bash
# Ver el nivel de contexto del proyecto y el stack detectado
malahor-ai context status
malahor-ai context detect

# Recuperar o guardar una capsula corta de contexto
malahor-ai context recover
malahor-ai context save "objetivo, estado, decisiones y proximo paso"

# Activar Obsidian solo para este proyecto
malahor-ai context obsidian on

# Revisar la memoria del proyecto
malahor-ai memory list
malahor-ai memory inspect <proyecto>

# Configurar el puente Obsidian (modo automatico: wsl-windows o windows-local)
malahor-ai obsidian status
malahor-ai obsidian guide
malahor-ai obsidian setup
```

En OpenCode, Malahor instala comandos slash equivalentes:

- `/recuperar-contexto`
- `/guardar-contexto`
- `/compactar-seguro`

Tambien puedes escribir “recuperar contexto” o “guardar contexto” y el agente debe aplicar el mismo protocolo.

Los comandos destructivos de memoria requieren confirmacion fuerte:

```bash
malahor-ai memory reset <proyecto> --yes --confirm <proyecto>
malahor-ai memory restore <backup> --yes --confirm RESTORE
```

## Troubleshooting

- `doctor` reporta fallos criticos: ejecuta `malahor-ai install` tras corregir el prerequisito.
- Graphify no encontrado: `pip install graphifyy`.
- Obsidian no conecta desde WSL: permite los puertos 27123 y 27124 en el Firewall de Windows y verifica el plugin "Local REST API".
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

MIT. Ver `LICENSE`.
