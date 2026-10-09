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
- Si el usuario dice `guardar contexto`, ejecutar el protocolo de `/guardar-contexto`: resumir objetivo, estado, decisiones, archivos, validaciones, bloqueos y proximo paso; guardar con `mem_session_summary` y solo mostrar confirmacion breve.
- No persistir secretos, tokens, passwords, credenciales ni llaves privadas.

## Recuperacion y compactacion de contexto

- Si el usuario dice `recuperar contexto`, tratarlo como `/recuperar-contexto`: generar una capsula breve usando `malahor-ai context recover`, Mnemo y lecturas dirigidas segun el nivel del proyecto.
- Mantener la capsula de recuperacion por debajo de ~1500 tokens: objetivo, estado actual, decisiones, archivos relevantes, siguiente paso y riesgos.
- No llenar la ventana con memoria completa, resultados largos de herramientas ni archivos completos salvo que sean imprescindibles.
- Antes de una compactacion manual o de una tarea larga, ejecutar `/guardar-contexto` o guardar un `mem_session_summary` equivalente.
- Si el usuario dice `compactar seguro`, guardar memoria primero, confirmar el proximo paso y luego compactar solo si el mecanismo disponible es seguro; si no, confiar en la compactacion automatica de OpenCode.
- Despues de compactar o al retomar una sesion, recuperar contexto antes de continuar con cambios.

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
- Para tareas de programacion, usar `programming.md` como router profundo y cargar skills especificas por tecnologia/practica (`programming/frontend/angular`, `programming/backend/spring-boot`, `programming/architecture/hexagonal-architecture`, `programming/devops/docker`, etc.).
- Flujo recomendado: `specialty-*` para orientacion general, luego `programming/*` para reglas concretas del stack.
- Las skills `programming/*` incluyen secciones de version/compatibilidad y referencias oficiales o canonicas; si el proyecto usa otra version, validar contra el manifiesto real antes de aplicar una recomendacion.
- Preferir siempre las skills first-party de Malahor antes que skills externas instaladas en la maquina.
- Las skills externas son complementarias y opcionales; Malahor no depende de ellas para operar.
- No incorporar skills externas al catalogo first-party sin auditoria previa: inventario, escaneo estatico, decision de viabilidad y reescritura segura.
- Las reescrituras first-party deben ser markdown en espanol, deterministas y sin scripts ejecutables por defecto.
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
- Para cambios no triviales (features nuevas, refactors amplios, cambios de arquitectura, integraciones o migraciones con riesgo de regresion), seguir el flujo SDD completo: cargar la skill `sdd` de `~/.malahor/assets/skills/` y ejecutar sus fases; `sdd-quality` antes de `sdd-verify`; si calidad falla, volver a `sdd-apply`; archivar el resultado en Mnemo.
- Preferir cambios pequenos y verificables.
- Para pruebas de Malahor, usar sandbox con `MALAHOR_HOME` y `MALAHOR_OPENCODE_DIR`.
- No tocar el entorno real si existe un sandbox activo.

## Commits

- No ejecutar `git add`, `git commit`, `commit --amend`, `push`, `reset` ni `checkout` salvo orden explicita del usuario.
- Al proponer texto de commit, usar la skill `git-commit-text` si esta disponible.
- Preferencia del usuario para mensajes de commit: titulo en espanol con icono referente al inicio, seguido de Conventional Commit (`✨ feat(scope): ...`, `🐛 fix(scope): ...`, etc.).
- Si el cuerpo aporta contexto, razon o impacto, escribirlo como lista con viñetas `-`, una idea por linea.
- No agregar atribucion de IA ni ruido ceremonial.
