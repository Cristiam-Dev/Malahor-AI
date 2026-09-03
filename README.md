# malahor-ai

CLI neutro de IA para desarrolladores. Se instala globalmente y potencia agentes como OpenCode, Claude Code, Cursor y Codex con memoria persistente, mapa estructural del codigo, orquestacion por subagentes, SDD y controles de calidad.

## Estado

Construccion inicial iniciada. La Fase 1 ya tiene scaffold npm, CLI minimo, Mnemo MCP, instalador OpenCode y sandbox de desarrollo para no tocar el entorno manual actual.

## Principio central

Malahor no debe dejar archivos dentro de los repos del usuario. Toda la configuracion, memoria, grafos y assets viven fuera del proyecto, principalmente en `~/.malahor/` y, opcionalmente, en `~/malahor/vault/`.

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
```
