export const docsToolDefinitions = [
  {
    name: "resolve",
    description: "Resuelve la raiz Markdown canonica de un proyecto registrado sin aceptar rutas arbitrarias.",
    inputSchema: projectSchema(),
  },
  {
    name: "list",
    description: "Lista archivos Markdown y directorios dentro del proyecto documental.",
    inputSchema: objectSchema({ project: stringProperty("Clave canonica del proyecto.", true), path: stringProperty("Directorio relativo; vacio = raiz.") }, ["project"]),
  },
  {
    name: "read",
    description: "Lee un Markdown y devuelve contenido, tamano y version SHA-256 para escritura condicional.",
    inputSchema: objectSchema({ project: stringProperty(undefined, true), path: stringProperty("Ruta .md relativa.", true) }, ["project", "path"]),
  },
  {
    name: "search",
    description: "Busca texto literal en Markdown del proyecto, sin salir de su raiz.",
    inputSchema: objectSchema({ project: stringProperty(undefined, true), query: stringProperty(undefined, true), limit: { type: "integer", minimum: 1, maximum: 50 } }, ["project", "query"]),
  },
  {
    name: "write",
    description: "Crea o reemplaza Markdown atomicamente. Crear exige ifNoneMatch='*'; reemplazar exige ifMatch de read.",
    inputSchema: writeSchema(),
  },
  {
    name: "append",
    description: "Anexa texto con el mismo control optimista de versiones que write.",
    inputSchema: writeSchema(),
  },
  {
    name: "move",
    description: "Mueve un Markdown dentro del mismo proyecto sin sobrescribir y con ifMatch del origen.",
    inputSchema: objectSchema({
      project: stringProperty(undefined, true),
      source: stringProperty("Ruta .md relativa de origen.", true),
      destination: stringProperty("Ruta .md relativa de destino.", true),
      ifMatch: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }, ["project", "source", "destination", "ifMatch"]),
  },
  {
    name: "open",
    description: "Abre la raiz o un Markdown relativo con el cliente humano configurado; no acepta comandos ni rutas absolutas.",
    inputSchema: objectSchema({
      project: stringProperty(undefined, true),
      path: stringProperty("Ruta relativa existente; ausente = raiz del proyecto."),
      app: { type: "string", enum: ["system", "vscode", "obsidian"] },
    }, ["project"]),
  },
] as const;

function projectSchema() {
  return objectSchema({ project: stringProperty("Clave canonica registrada en projects.json.", true) }, ["project"]);
}

function writeSchema() {
  return objectSchema({
    project: stringProperty(undefined, true),
    path: stringProperty("Ruta .md relativa.", true),
    content: stringProperty("Markdown UTF-8."),
    ifMatch: { type: "string", description: "Version SHA-256 para reemplazar.", pattern: "^[a-f0-9]{64}$" },
    ifNoneMatch: { type: "string", enum: ["*"] },
  }, ["project", "path", "content"]);
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringProperty(description?: string, nonEmpty = false) {
  return { type: "string", ...(description ? { description } : {}), ...(nonEmpty ? { minLength: 1 } : {}) };
}
