import "dotenv/config";

const PRIMARY = process.env.EMBEDDINGS_PROVIDER || "ollama";
const FALLBACK = process.env.EMBEDDINGS_FALLBACK_PROVIDER || null;

const PROVIDERS = {
  ollama: embedOllama,
  voyage: embedVoyage,
  openai: embedOpenAI,
};

/**
 * Devuelve un array de vectores (uno por texto de entrada).
 * Intenta con el proveedor principal; si falla (red caida, API sin credito,
 * rate limit, etc) reintenta automaticamente con el de respaldo, si hay uno
 * configurado.
 *
 * IMPORTANTE: si el proveedor de respaldo devuelve vectores de OTRA
 * dimension que el principal, Qdrant va a rechazar el upsert (la coleccion
 * ya tiene una dimension fija). Para que el fallback funcione sin friccion:
 *   - usa dos proveedores que generen la MISMA dimension, o
 *   - crea colecciones separadas por proveedor (ver nota en README), o
 *   - usa el fallback solo para diagnostico y reindexa manualmente despues
 * En este skeleton, si detectamos un mismatch de dimension contra la
 * coleccion existente, lanzamos un error explicito en vez de corromper el
 * indice.
 */
export async function embed(texts) {
  if (!PROVIDERS[PRIMARY]) {
    throw new Error(`Proveedor de embeddings desconocido: ${PRIMARY}`);
  }

  try {
    return await PROVIDERS[PRIMARY](texts);
  } catch (err) {
    if (!FALLBACK) {
      throw new Error(`Fallo el proveedor principal "${PRIMARY}" y no hay fallback configurado: ${err.message}`);
    }
    if (!PROVIDERS[FALLBACK]) {
      throw new Error(`Proveedor de fallback desconocido: ${FALLBACK}`);
    }
    console.warn(`[embeddings] Proveedor principal "${PRIMARY}" fallo (${err.message}). Usando fallback "${FALLBACK}"...`);
    return await PROVIDERS[FALLBACK](texts);
  }
}

/**
 * Ollama local: gratis, sin API key, corre en tu maquina.
 * Requiere tener Ollama instalado y el modelo descargado:
 *   ollama pull nomic-embed-text
 * o
 *   ollama pull bge-m3
 */
async function embedOllama(texts) {
  const baseUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const model = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";

  // /api/embed acepta el batch completo y trunca al context length del modelo
  // (el viejo /api/embeddings devolvia error con chunks > 2048 tokens en nomic,
  // lo que disparaba el fallback a mitad del indexado).
  // ponytail: truncar pierde el final de chunks enormes (clases enteras); si
  // importa, partir los chunks grandes en chunker.js.
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts, truncate: true }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings error: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).embeddings;
}

async function embedVoyage(texts) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: process.env.VOYAGE_MODEL || "voyage-code-3",
      input_type: "document",
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embeddings error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

async function embedOpenAI(texts) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}
