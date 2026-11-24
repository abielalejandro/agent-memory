import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embed } from "./embeddings.js";

const COLLECTION = process.env.QDRANT_COLLECTION || "code_knowledge";
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || "http://localhost:6333" });

/**
 * Busca contexto relevante en el codigo indexado.
 * @param {string} query - pregunta en lenguaje natural
 * @param {object} opts
 * @param {string} [opts.project] - filtrar por proyecto especifico
 * @param {number} [opts.limit]
 * @param {string} [opts.contains] - palabra(s) que el chunk debe contener (case-insensitive,
 *   por palabra). Util para identificadores/nombres propios que los embeddings no captan.
 */
export async function searchCodebase(query, { project, limit = 8, contains } = {}) {
  const [vector] = await embed([query]);
  const must = [];
  if (project) must.push({ key: "project", match: { value: project } });
  if (contains) must.push({ key: "text", match: { text: contains } });
  // Las cabeceras (package/imports) son casi vacias y se cuelan en cualquier
  // busqueda; solo sirven para getProjectContext.
  const filter = { must, must_not: [{ key: "type", match: { any: ["java-header", "csharp-header"] } }] };

  const { points } = await qdrant.query(COLLECTION, {
    query: vector,
    limit,
    filter,
    with_payload: true,
  });

  return points.map((r) => ({
    score: r.score,
    project: r.payload.project,
    file: r.payload.file,
    type: r.payload.type,
    lines: `${r.payload.startLine}-${r.payload.endLine}`,
    text: r.payload.text,
  }));
}

/**
 * Devuelve un resumen general de un proyecto: headers, y las decisiones
 * (ADRs) registradas para el. Util para "ponerse al dia" al empezar sesion.
 */
export async function getProjectContext(project, { limit = 15 } = {}) {
  const results = await qdrant.scroll(COLLECTION, {
    filter: {
      must: [
        { key: "project", match: { value: project } },
        { key: "type", match: { any: ["java-header", "csharp-header", "decision"] } },
      ],
    },
    limit,
    with_payload: true,
  });

  return results.points.map((p) => ({
    type: p.payload.type,
    file: p.payload.file,
    text: p.payload.text,
    createdAt: p.payload.createdAt,
  }));
}

/**
 * Registra una decision/ADR corta para que quede indexada y sea
 * recuperable por busqueda semantica en el futuro.
 */
export async function logDecision({ project, title, context, decision, consequences }) {
  const text =
    `// decision registrada - proyecto: ${project}\n` +
    `## ${title}\n\n` +
    `**Contexto:** ${context}\n\n` +
    `**Decision:** ${decision}\n\n` +
    `**Consecuencias:** ${consequences || "N/A"}`;

  const [vector] = await embed([text]);
  const id = Date.now();

  await qdrant.upsert(COLLECTION, {
    points: [
      {
        id,
        vector,
        payload: {
          text,
          project,
          file: `adr/${title.toLowerCase().replace(/\s+/g, "-")}.md`,
          type: "decision",
          createdAt: new Date().toISOString(),
        },
      },
    ],
  });

  return { id, text };
}
