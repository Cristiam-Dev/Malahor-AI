export const toolDefinitions = [
  {
    name: "mem_save",
    description: "Guarda una decision, bug, patron o aprendizaje. Usa una clave jerarquica interna (empresa/proyecto/modulo/feature) inferida del contexto; no le pidas al usuario escribirla.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Scope activo inferido del workspace y la tarea; puede ser empresa/proyecto/modulo/feature." },
        type: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "string" },
      },
      required: ["project", "title", "content"],
    },
  },
  {
    name: "mem_search",
    description: "Busca en memoria por keywords.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        type: { type: "string" },
        limit: { type: "number" },
        subtree: { type: "boolean", description: "Incluye el scope exacto y todos sus descendientes; requiere project." },
      },
    },
  },
  {
    name: "mem_get",
    description: "Detalle completo de una observacion por ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "mem_context",
    description: "Recupera contexto reciente del scope indicado y hereda automaticamente memorias de sus scopes padre y global.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Scope actual; puede ser jerarquico y hereda sus padres automaticamente." },
        limit: { type: "number" },
        budget: { type: "number", description: "Presupuesto maximo aproximado en caracteres JSON; no trunca recuerdos." },
        rollup: { type: "boolean", description: "Incluye memorias y sesiones de los scopes descendientes del scope activo." },
      },
      required: ["project"],
    },
  },
  {
    name: "mem_brief",
    description: "Entiende una peticion en lenguaje natural, devuelve el contexto jerarquico y busca memorias antiguas relacionadas en otros scopes. El agente debe inferir project/scope del mensaje y el workspace; el usuario no necesita conocer claves tecnicas.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "Peticion literal o resumida del usuario; puede mencionar asignacion nueva y contexto anterior que quiera reutilizar." },
        project: { type: "string", description: "Proyecto actual inferido del workspace, si es conocido." },
        scope: { type: "string", description: "Scope inferido por el agente del lenguaje natural, por ejemplo empresa/proyecto/modulo/feature; nunca pedir esta clave al usuario." },
        limit: { type: "number", description: "Maximo de memorias heredadas (default 8)." },
        relatedLimit: { type: "number", description: "Maximo de recuerdos relacionados de otros scopes (default 5)." },
        budget: { type: "number", description: "Presupuesto maximo aproximado en caracteres JSON para recuerdos y sesion." },
      },
      required: ["request"],
    },
  },
  {
    name: "mem_session_summary",
    description: "Guarda resumen de la sesion actual.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Scope activo donde guardar el checkpoint." },
        summary: { type: "string" },
      },
      required: ["project", "summary"],
    },
  },
  {
    name: "mem_list_projects",
    description: "Lista proyectos con memoria guardada.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mem_tree",
    description: "Lista el arbol de scopes y sus conteos. Puede limitarlo a un prefijo/subarbol canonico.",
    inputSchema: {
      type: "object",
      properties: { prefix: { type: "string", description: "Scope raiz opcional del subarbol." } },
    },
  },
  {
    name: "mem_pin",
    description: "Fija una observacion para priorizarla al construir contexto. Requiere memoria v2 activa; un pin no otorga autoridad ni resuelve conflictos.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "mem_unpin",
    description: "Retira el pin de una observacion de forma idempotente. Requiere memoria v2 activa.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "mem_promote_preview",
    description: "Previsualiza consolidar una observacion en un scope ancestro estricto. No modifica nada; usar antes de pedir confirmacion.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, ancestor: { type: "string", description: "Scope ancestro destino." } },
      required: ["id", "ancestor"],
    },
  },
  {
    name: "mem_promote",
    description: "Promueve una observacion a un ancestro estricto solo con confirmacion exacta del preview y backup consistente. Requiere memoria v2 activa.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        ancestor: { type: "string" },
        confirm: { type: "string", description: "Debe coincidir exactamente con requiresConfirmation de mem_promote_preview." },
      },
      required: ["id", "ancestor", "confirm"],
    },
  },
  {
    name: "mem_delete_project_preview",
    description: "Previsualiza el borrado de memoria de un proyecto/scope exacto. No borra nada; usa esta herramienta antes de pedir confirmacion al usuario.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proyecto o scope exacto a evaluar." },
      },
      required: ["project"],
    },
  },
  {
    name: "mem_delete_project",
    description: "Borra memoria de un proyecto/scope exacto solo con confirmacion explicita. Crea backup automatico. No borra scopes hijos.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proyecto o scope exacto a borrar." },
        confirm: { type: "string", description: "Debe coincidir exactamente con requiresConfirmation devuelto por mem_delete_project_preview." },
      },
      required: ["project", "confirm"],
    },
  },
  {
    name: "mem_backup",
    description: "Crea un backup inmediato de la base Mnemo actual. Usar antes de operaciones administrativas si el usuario lo pide.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mem_restore_preview",
    description: "Previsualiza la restauracion de un backup Mnemo. No restaura nada; solo acepta backups dentro de ~/.malahor/backups.",
    inputSchema: {
      type: "object",
      properties: {
        backup: { type: "string", description: "Nombre de archivo del backup o ruta absoluta dentro de ~/.malahor/backups." },
      },
      required: ["backup"],
    },
  },
  {
    name: "mem_restore",
    description: "Restaura un backup Mnemo solo con confirmacion exacta RESTORE. Crea backup del estado actual antes de restaurar.",
    inputSchema: {
      type: "object",
      properties: {
        backup: { type: "string", description: "Nombre de archivo del backup o ruta absoluta dentro de ~/.malahor/backups." },
        confirm: { type: "string", description: "Debe ser exactamente RESTORE." },
      },
      required: ["backup", "confirm"],
    },
  },
  {
    name: "mem_inspect_project",
    description: "Inspecciona administrativamente un proyecto/scope exacto: conteos, hijos, sesiones y observaciones recientes.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proyecto o scope exacto a inspeccionar." },
      },
      required: ["project"],
    },
  },
  {
    name: "mem_move_preview",
    description: "Previsualiza mover/reclasificar una observacion a otro proyecto/scope. No modifica nada.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID de observacion." },
        targetProject: { type: "string", description: "Proyecto/scope destino." },
      },
      required: ["id", "targetProject"],
    },
  },
  {
    name: "mem_move",
    description: "Mueve/reclasifica una observacion a otro proyecto/scope solo con confirmacion exacta. Crea backup automatico.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID de observacion." },
        targetProject: { type: "string", description: "Proyecto/scope destino." },
        confirm: { type: "string", description: "Debe coincidir con requiresConfirmation devuelto por mem_move_preview." },
      },
      required: ["id", "targetProject", "confirm"],
    },
  },
  {
    name: "malahor_hook_check",
    description: "Ejecuta guardrails cross-harness de Malahor antes de acciones sensibles (git, memoria, instalacion, archivos, secretos). Usar antes de commit/push/reset/push --force, writes de Obsidian o acciones destructivas.",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "string", description: "Evento hook, por ejemplo git.commit.before, git.push.before, memory.delete.apply, install.beforePolicy." },
        profile: { type: "string", description: "off|light|standard|strict|release. Default standard." },
        command: { type: "string", description: "Comando shell que se planea ejecutar, si aplica." },
        paths: { type: "array", items: { type: "string" }, description: "Archivos objetivo a revisar." },
        confirm: { type: "string", description: "Confirmacion exacta para operaciones destructivas; CHECKS_OK no autoriza una operacion ask." },
        metadata: { type: "object", description: "Metadatos del evento (previewToken, requiresConfirmation, writesMalahorData, etc.)." },
      },
      required: ["event"],
    },
  },
];
