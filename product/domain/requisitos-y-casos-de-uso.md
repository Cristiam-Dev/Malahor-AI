# Requisitos y casos de uso - malahor-ai

## Actores

- Desarrollador: instala y usa Malahor en sus proyectos.
- Agente de IA: consume memoria, grafos y reglas de orquestacion.
- Orquestador Malahor: coordina memoria, Graphify, SDD y subagentes.

## Modulos funcionales

- CLI de instalacion.
- Detector de entorno y agentes.
- Backup e inyeccion de configuraciones.
- Mnemo MCP server.
- Integracion Graphify externa.
- Assets de orquestacion OpenCode.
- Skills SDD.
- Quality tools.
- Doctor, update y uninstall.

## Reglas de negocio

- Malahor no debe crear archivos dentro de repositorios del usuario.
- Toda configuracion propia debe vivir en `~/.malahor/` o en rutas globales del agente.
- Antes de modificar una configuracion existente, debe crear backup con timestamp.
- La configuracion MCP para OpenCode debe usar `type: "local"`, `command` como array y `enabled: true`.
- Mnemo debe rechazar contenido sensible si detecta passwords, secrets, tokens, API keys o private keys.
- Graphify debe usar `GRAPHIFY_OUT` apuntando a `~/.malahor/graphs/$PROJECT`.
- El proyecto activo debe inferirse automaticamente sin preguntarle al usuario.

## Casos de uso

### CU-CLI-1 Instalar Malahor en OpenCode

Actor: Desarrollador.

Flujo principal:

1. El desarrollador ejecuta `malahor-ai install`.
2. El CLI detecta sistema operativo, WSL y OpenCode.
3. El CLI muestra resumen y pide confirmacion.
4. El CLI crea backups de configuraciones existentes.
5. El CLI instala Mnemo en `~/.malahor/mnemo/`.
6. El CLI crea `~/.malahor/graphs/`.
7. El CLI verifica o instala Graphify.
8. El CLI copia `OPENCODE.md` a la configuracion global de OpenCode.
9. El CLI inyecta Mnemo en `opencode.jsonc`.
10. El CLI muestra reporte final.

Criterio de exito: OpenCode arranca sin errores y muestra Mnemo como MCP habilitado.

### CU-MEM-1 Recuperar contexto al iniciar sesion

Actor: Agente de IA.

Flujo principal:

1. El orquestador detecta el proyecto activo.
2. El orquestador llama `mem_context` con el proyecto detectado.
3. Si existe contexto, lo resume en una linea.
4. Si no existe contexto, informa que es la primera sesion del proyecto.

Criterio de exito: el usuario no necesita ejecutar comandos manuales de memoria.

### CU-GRAPH-1 Generar mapa estructural fuera del repo

Actor: Orquestador Malahor.

Flujo principal:

1. El orquestador verifica si existe `~/.malahor/graphs/$PROJECT/graph.json`.
2. Si no existe, ejecuta Graphify con `GRAPHIFY_OUT` externo.
3. El agente usa el grafo para orientarse antes de leer archivos raw.

Criterio de exito: no se crea ningun archivo de Graphify dentro del repo del usuario.

### CU-SDD-1 Ejecutar flujo SDD para cambio no trivial

Actor: Desarrollador.

Flujo principal:

1. El usuario solicita una implementacion no trivial.
2. El orquestador inicia flujo SDD.
3. El orquestador explora con Graphify y memoria Mnemo.
4. El orquestador propone solucion y genera especificacion.
5. El orquestador delega implementacion a subagentes.
6. El orquestador ejecuta calidad y verifica contra la especificacion.
7. El orquestador archiva decisiones en Mnemo.

Criterio de exito: la implementacion queda trazable y validada sin ensuciar el repositorio.
