# Instrucciones Globales - Malahor AI

## Contexto

- Responder siempre en espanol.
- Cargar memoria del proyecto con Mnemo al inicio de cada sesion.
- Cuando la referencia sea inequívoca, normalizar `malaho`, `malahor`, `MalaHor`, `malahor ai`, `malahor-ai`, `malahor_ai` y variantes equivalentes hacia el proyecto `malahor`.
- Resolver siempre el proyecto activo a una clave canonica antes de usar Mnemo, Graphify, Vikunja u Obsidian.
- Orden oficial de contexto: ProjectResolver, Mnemo, Graphify, Obsidian MCP y lectura puntual de archivos.
- Respetar `plan` y `build` de OpenCode como fuente de verdad para la fase actual.
- En `plan`, priorizar exploracion, analisis, propuesta, especificacion y diseno antes de ejecutar cambios.
- En `build`, usar la politica de intervencion de Malahor para ejecutar, guiar o acompanar segun corresponda.
- No escribir archivos dentro de repos del usuario para configuracion global, memoria, grafos o assets de Malahor.

## Intervencion en ejecucion

- `ejecutar`: puedes modificar archivos, ejecutar comandos necesarios y verificar leyendo archivos.
- `guiar`: no modifiques archivos; indica pasos concretos, archivos o lineas a tocar, y verifica solo leyendo archivos cuando el usuario lo pida o aplique cambios.
- `acompanar`: no modifiques archivos, no ejecutes comandos, no leas archivos para verificar y no des rutas ni lineas concretas; entrega solo la solucion conceptual.
- `verificacion` significa leer archivos para comprobar que todo quedo bien, sin modificar nada.
- Si la politica activa deshabilita verificacion, no hagas comprobaciones posteriores aunque sean read-only.

## Memoria

- Usar Mnemo para decisiones, bugs, patrones, arquitectura, aprendizajes y resumen de sesion.
- Usar siempre la clave canonica del proyecto como `project` en Mnemo.
- Guardar cambios importantes al cerrar una tarea.
- No persistir secretos, tokens, passwords, credenciales ni llaves privadas.

## Graphify

- Usar Graphify como contexto tecnico prioritario despues de Mnemo, cuando el nivel de contexto del proyecto lo incluya.
- Preferir Graphify antes que Obsidian para entender estructura, modulos, dependencias y archivos relevantes del codigo.
- Graphify debe escribir siempre fuera del repo objetivo, en `~/.malahor/graphs/<canonicalKey>`.
- No permitir salida por defecto de Graphify dentro del repositorio del usuario.
- Si Graphify no esta disponible, informar la limitacion y usar lectura puntual de archivos concretos.

## Contexto por Proyecto

- Cada proyecto tiene un nivel de contexto: `mnemo`, `mnemo+graphify` (default) o `mnemo+graphify+obsidian`.
- Consultar el nivel del proyecto activo antes de usar Graphify u Obsidian: `malahor-ai context status` o el archivo `~/.malahor/projects.json`.
- Mnemo siempre esta activo, sin importar el nivel.
- Usar Graphify solo si el nivel del proyecto lo incluye.
- Usar Obsidian MCP solo si el nivel del proyecto lo incluye y el puente esta configurado.
- Activar o desactivar Obsidian por proyecto con `malahor-ai context obsidian on|off`, sin pedir rutas markdown genericas.
- No pedir al usuario rutas de vaults ni rutas markdown para contexto; Obsidian se opera siempre via Obsidian MCP.

## Skills

- Las skills first-party de Malahor viven en `~/.malahor/assets/skills`.
- Antes de tareas tecnicas de especialidad, ejecutar `malahor-ai context detect` y cargar la skill sugerida siguiendo el router `specialty.md`.
- Preferir siempre las skills first-party de Malahor antes que skills externas instaladas en la maquina.
- Las skills externas son complementarias y opcionales; Malahor no depende de ellas para operar.
- No crear skills nuevas sin pedido explicito del usuario.

## Proyecto Activo

- Inferir el proyecto desde el directorio actual, `package.json` o `.git` cuando sea claro.
- Normalizar mayusculas, acentos, espacios, guiones, underscores y aliases antes de crear contexto nuevo.
- Si hay una coincidencia canonica clara, reutilizarla sin crear proyectos alternos.
- Si hay varias coincidencias plausibles, preguntar antes de cargar o crear contexto.
- Mnemo, Graphify, Vikunja y Obsidian deben usar la misma clave canonica resuelta.

## Obsidian

- Obsidian es solo para documentacion, procesos, conocimiento, notas de diseno, decisiones humanas, guias operativas y material de referencia.
- Consultar Obsidian despues de Mnemo y Graphify, salvo que la tarea sea puramente documental, y solo cuando el nivel de contexto del proyecto incluya Obsidian.
- Operar Obsidian solo mediante Obsidian MCP.
- No buscar ni modificar vaults por filesystem directo.
- No usar lectura de markdown externo generico como flujo separado; si el contexto documental markdown debe operarse, usar Obsidian MCP.
- Si Obsidian MCP no esta disponible, informar la limitacion.
- Contrato lectura/escritura del Obsidian MCP: `obsidian_get_file_contents` puede devolver el contenido codificado como string JSON (envuelto en comillas, con `\n` literales); `obsidian_put_content` y `obsidian_append_content` escriben contenido crudo.
- Decodificar SIEMPRE la salida de `obsidian_get_file_contents` (JSON.parse) antes de leerla o editarla; nunca reescribir en el vault texto tal como llega del GET.
- Si el contenido leido empieza con comilla doble o contiene `\n` literales, tratarlo como codificado y decodificarlo primero.
- Verificar despues de cada escritura con un nuevo GET decodificado: el disco debe quedar en markdown limpio, sin comilla inicial ni `\n` literales.
- `obsidian_delete_file` puede fallar con error 40400 pero borrar igual; tras borrar, listar el directorio para confirmar el estado real.

## Vikunja

- Vikunja es la capa operativa para proyectos, tareas, pendientes, seguimiento y estado de trabajo.
- Buscar proyectos existentes por alias antes de crear duplicados.
- No crear archivos `Tareas.md` en Obsidian.

## Desarrollo

- Antes de editar, leer el contexto del proyecto.
- Para cambios tecnicos, orientarse con Mnemo y Graphify antes de leer archivos raw amplios.
- Preferir cambios pequenos y verificables.
- Para pruebas de Malahor, usar sandbox con `MALAHOR_HOME` y `MALAHOR_OPENCODE_DIR`.
- No tocar el entorno real si existe un sandbox activo.
