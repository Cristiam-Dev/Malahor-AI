# specialty

Router de skills de especialidad first-party de Malahor. Selecciona la skill correcta antes de implementar tareas tecnicas de backend, frontend, devops, diseno o integracion de IA.

## Usar Cuando

- La tarea toca una especialidad tecnica comun (backend, frontend, devops, diseno, IA).
- El proyecto coincide con un stack conocido o la tarea pide una especialidad concreta.

## Flujo

1. Ejecutar `malahor-ai context detect` para obtener el stack detectado y las skills sugeridas.
2. Mapear el stack o la tarea a la skill correspondiente:

| Stack o tarea | Skill |
|---|---|
| APIs, servicios, datos, Java/Spring, Node/Express, SQL, NoSQL, vectoriales | `specialty-backend` |
| UI, SPA, React/Next, Angular, Vue, Svelte, TypeScript, accesibilidad | `specialty-frontend` |
| CI/CD, contenedores, despliegue, cloud, infraestructura | `specialty-devops` |
| UI/UX, branding, sitios web, diseno visual | `specialty-design` |
| RAG, LLM providers, MCP, embeddings, seguridad y costos de IA | `specialty-ai-integration` |

3. Cargar la skill seleccionada y seguir sus reglas.
4. Si ninguna aplica, no cargar ninguna y trabajar con las reglas generales y SDD.

## Reglas

- Preferir siempre las skills first-party de Malahor antes que skills externas instaladas en la maquina.
- Las skills externas son complementarias y opcionales; nunca requeridas para operar.
- Una sola skill de especialidad por tarea, salvo que el trabajo combine areas de forma real.
- No crear skills nuevas sin pedido explicito del usuario; ampliar el catalogo es decision del usuario.
- Guardar decisiones relevantes en Mnemo con la clave canonica del proyecto.
