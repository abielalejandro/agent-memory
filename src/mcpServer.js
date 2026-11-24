import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchCodebase, getProjectContext, logDecision } from "./knowledge.js";

const server = new McpServer({
  name: "agent-memory",
  version: "0.1.0",
});

server.tool(
  "search_codebase",
  "Busca fragmentos de codigo o documentacion relevantes en la base de conocimiento indexada, usando busqueda semantica. Usar antes de explorar archivos manualmente cuando se necesita entender como esta implementado algo.",
  {
    query: z.string().describe("Pregunta o descripcion de lo que se busca, en lenguaje natural"),
    project: z.string().optional().describe("Nombre del proyecto para filtrar (carpeta dentro de PROJECTS_ROOT)"),
    limit: z.number().optional().describe("Cantidad maxima de resultados (default 8)"),
    contains: z
      .string()
      .optional()
      .describe(
        "Palabra exacta que el fragmento debe contener (case-insensitive). Usar para nombres propios, " +
          "clientes, constantes o identificadores (ej. TECHHUB), que la busqueda semantica sola no encuentra bien"
      ),
  },
  async ({ query, project, limit, contains }) => {
    const results = await searchCodebase(query, { project, limit, contains });
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  "get_project_context",
  "Devuelve un resumen de contexto de un proyecto: cabeceras de archivos clave y decisiones de arquitectura (ADRs) registradas. Usar al empezar a trabajar en un proyecto para ponerse al dia rapido.",
  {
    project: z.string().describe("Nombre del proyecto"),
  },
  async ({ project }) => {
    const context = await getProjectContext(project);
    return {
      content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
    };
  }
);

server.tool(
  "log_decision",
  "Registra una decision de diseno o arquitectura (ADR corto) para que quede indexada y disponible para futuras consultas de cualquier agente. Usar cada vez que se resuelve algo no trivial o se descarta una alternativa.",
  {
    project: z.string(),
    title: z.string().describe("Titulo corto de la decision"),
    context: z.string().describe("Que problema o situacion motivo la decision"),
    decision: z.string().describe("Que se decidio hacer"),
    consequences: z.string().optional().describe("Trade-offs o efectos secundarios conocidos"),
  },
  async ({ project, title, context, decision, consequences }) => {
    const saved = await logDecision({ project, title, context, decision, consequences });
    return {
      content: [{ type: "text", text: `Decision registrada con id ${saved.id}` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
