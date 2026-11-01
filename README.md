# malahor-ai

CLI local para potenciar agentes de IA —OpenCode primero— con memoria
persistente, documentación Markdown externa, contexto por proyecto, SDD y
guardrails. La configuración y los datos operativos viven fuera de los
repositorios de código.

## Requisitos

- Node.js 22.18.0 o superior.
- OpenCode V2.
- Linux, WSL, macOS o Windows como usuario estándar.
- Bun, solo para desarrollar desde el código fuente.

## Instalación

La vía recomendada es abrir OpenCode y escribir:

```text
instala malahor
```

El agente prepara el bootstrap y solicita las aprobaciones necesarias antes de
modificar la instalación.

Desde terminal, cuando el paquete esté publicado:

```bash
npm install -g malahor-ai
malahor-ai install --bootstrap --yes
malahor-ai doctor
```

Desde un checkout local:

```bash
bun install
bun run build
node dist/index.js install --yes
node dist/index.js doctor
```

## Primeros pasos

```bash
# Verifica el runtime y sus capacidades
malahor-ai doctor

# Revisa el proyecto y el contexto detectado
malahor-ai context status
malahor-ai context detect

# Resuelve y abre la documentación canónica
malahor-ai docs status
malahor-ai docs open --app system
```

En OpenCode puedes pedir acciones en lenguaje natural:

```text
recupera el contexto de este proyecto
busca la decisión de autenticación
crea un ADR para la persistencia
revisa estos cambios
```

Malahor infiere proyecto, scope y ubicación documental. No necesitas conocer
claves internas, hashes ni rutas del vault.

## Comandos esenciales

| Comando | Uso |
|---|---|
| `malahor-ai install` | Instala runtime, plugin, agentes y assets gestionados. |
| `malahor-ai update` | Actualiza de forma convergente con backup y rollback. |
| `malahor-ai doctor` | Diagnostica y valida la instalación. |
| `malahor-ai context` | Gestiona proyectos y niveles de contexto. |
| `malahor-ai docs` | Resuelve, valida y abre el vault externo. |
| `malahor-ai memory` | Administra la memoria persistente. |
| `malahor-ai hooks` | Evalúa guardrails cross-harness. |

La documentación de cada proyecto vive en su vault externo. Ábrela con
`malahor-ai docs open`.

## Seguridad

- Git es local-only: las operaciones remotas están bloqueadas.
- Stage, commit y operaciones destructivas requieren flujos explícitos.
- Memoria, documentación, backups e índices se almacenan fuera del repositorio.
- CI/CD, IaC, publicación y despliegue son superficies protegidas.

Malahor es un CLI para uso manual o asistido con OpenCode. No expone todavía
una API pública estable ni funciona como SDK embebible.

## Desarrollo

```bash
bun install
bun run typecheck
bun test
bun run build
```

Los scripts `dev:sandbox`, `doctor:sandbox` y `sandbox:reset` permiten validar
sin tocar la instalación real.

## Licencia

Software propietario. Consulta [LICENSE](LICENSE) y
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
