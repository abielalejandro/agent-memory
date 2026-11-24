import "dotenv/config";
import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embed } from "./embeddings.js";
import { chunkFile } from "./chunker.js";

const PROJECTS_ROOT = process.env.PROJECTS_ROOT;
const COLLECTION = process.env.QDRANT_COLLECTION || "code_knowledge";
const BATCH_SIZE = 32;

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || "http://localhost:6333" });

const INCLUDE_PATTERNS = [
  "**/*.java",
  "**/*.cs",
  "**/*.md",
  "**/*.yml",
  "**/*.yaml",
  "**/*.properties",
  "**/*.json",
  "**/adr/**/*.md",
];

const EXCLUDE_PATTERNS = [
  // config con posibles secretos: no deben terminar en Qdrant ni en respuestas a agentes
  "**/appsettings*.json",
  "**/application*.{yml,yaml,properties}",
  "**/bootstrap*.{yml,yaml,properties}",
  "**/secrets*.json",
  "**/target/**",
  "**/build/**",
  "**/bin/**",
  "**/obj/**",
  "**/node_modules/**",
  "**/.git/**",
  "**/package-lock.json",
];

async function ensureCollection(vectorSize) {
  const collections = await qdrant.getCollections();
  const existing = collections.collections.find((c) => c.name === COLLECTION);
  if (!existing) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: vectorSize, distance: "Cosine" },
    });
    console.log(`Coleccion "${COLLECTION}" creada (dim=${vectorSize})`);
  } else {
    assertSameDim((await qdrant.getCollection(COLLECTION)).config.params.vectors.size, vectorSize);
  }

  // Indice full-text para el filtro `contains` de searchCodebase: case-insensitive
  // y por palabra (TECHHUB matchea TechHub, TECHHUB_ORDERS, techhub-api).
  // Idempotente: recrearlo con el mismo esquema no falla.
  await qdrant.createPayloadIndex(COLLECTION, {
    wait: true,
    field_name: "text",
    field_schema: { type: "text", tokenizer: "word", lowercase: true },
  });
}

function assertSameDim(existingSize, vectorSize) {
  if (existingSize !== vectorSize) {
    throw new Error(
      `Dimension incompatible: la coleccion "${COLLECTION}" espera vectores de ${existingSize}, ` +
      `pero el proveedor de embeddings activo genero ${vectorSize}. ` +
      `Esto suele pasar cuando cambio el proveedor primario/fallback entre indexados. ` +
      `Opciones: (a) usa siempre el mismo proveedor para esta coleccion, ` +
      `(b) crea una coleccion nueva con QDRANT_COLLECTION distinto, o ` +
      `(c) borra y reindexa todo desde cero con el proveedor que quieras usar.`
    );
  }
}

function stableId(project, file, startLine, endLine) {
  // UUID estable (128 bits de md5): un hash de 32 bits colisiona con ~40k chunks
  const h = createHash("md5").update(`${project}:${file}:${startLine}:${endLine}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function indexProject(projectName, projectPath) {
  console.log(`\n=== Indexando proyecto: ${projectName} ===`);
  const files = await fg(INCLUDE_PATTERNS, {
    cwd: projectPath,
    ignore: EXCLUDE_PATTERNS,
    absolute: false,
  });
  console.log(`Archivos encontrados: ${files.length}`);

  let allChunks = [];
  for (const relFile of files) {
    const fullPath = path.join(projectPath, relFile);
    const content = await fs.readFile(fullPath, "utf-8");
    const chunks = chunkFile(relFile, content);
    for (const c of chunks) {
      c.metadata.project = projectName;
    }
    allChunks = allChunks.concat(chunks);
  }
  console.log(`Chunks generados: ${allChunks.length}`);

  let expectedDim = null;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const vectors = await embed(batch.map((c) => c.text));

    if (expectedDim === null) {
      await ensureCollection(vectors[0].length);
      expectedDim = vectors[0].length;
      // Borra el codigo previo del proyecto (archivos borrados, lineas corridas)
      // pero conserva los ADRs registrados con logDecision.
      // ponytail: si el indexado falla despues de esto, el proyecto queda parcial
      // hasta el proximo reindexado; un proyecto sin chunks no se limpia.
      await qdrant.delete(COLLECTION, {
        wait: true,
        filter: {
          must: [{ key: "project", match: { value: projectName } }],
          must_not: [{ key: "type", match: { value: "decision" } }],
        },
      });
    } else if (vectors[0].length !== expectedDim) {
      throw new Error(
        `El batch en el offset ${i} genero vectores de dimension ${vectors[0].length}, ` +
        `pero se esperaba ${expectedDim} (probablemente el proveedor de respaldo se activo ` +
        `a mitad del indexado). Revisa por que fallo el proveedor principal y reintenta.`
      );
    }

    const points = batch.map((c, idx) => ({
      id: stableId(projectName, c.metadata.file, c.metadata.startLine, c.metadata.endLine),
      vector: vectors[idx],
      payload: {
        text: c.text,
        ...c.metadata,
      },
    }));

    await qdrant.upsert(COLLECTION, { points });
    process.stdout.write(`  indexados ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length}\r`);
  }
  console.log(`\nProyecto "${projectName}" indexado OK.`);
}

function isIndexableFile(relFile) {
  const normalized = relFile.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = path.posix.basename(normalized);
  const parts = normalized.split("/");

  const excludedDirs = new Set(["target", "build", "bin", "obj", "node_modules", ".git"]);
  if (parts.some((p) => excludedDirs.has(p))) return false;
  if (base === "package-lock.json") return false;
  if (/^appsettings.*\.json$/i.test(base)) return false;
  if (/^secrets.*\.json$/i.test(base)) return false;
  if (/^(application|bootstrap).*\.(yml|yaml|properties)$/i.test(base)) return false;

  return /\.(java|cs|md|yml|yaml|properties|json)$/i.test(base);
}

async function indexProjectFiles(projectName, projectPath, rawFiles) {
  const normalizedFiles = [...new Set(
    rawFiles
      .map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "").trim())
      .filter((f) => f.length > 0 && isIndexableFile(f))
  )];

  if (normalizedFiles.length === 0) {
    console.log(`[incremental] ${projectName}: sin archivos indexables en los cambios.`);
    return;
  }

  console.log(`\n=== Indexado incremental: ${projectName} (${normalizedFiles.length} archivo(s)) ===`);

  let allChunks = [];
  for (const relFile of normalizedFiles) {
    const fullPath = path.join(projectPath, relFile);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(fullPath, "utf-8");
      const chunks = chunkFile(relFile, content);
      for (const c of chunks) {
        c.metadata.project = projectName;
      }
      allChunks = allChunks.concat(chunks);
    } catch (err) {
      if (err.code === "ENOENT") {
        // Archivo eliminado en el commit: sus puntos viejos se borran abajo.
        continue;
      }
      throw err;
    }
  }

  // Solo borra en Qdrant si la coleccion existe (en incremental asumimos que ya existe; si hay chunks nuevos, ensureCollection la valida/crea).
  const deleteOldFilePoints = async () => {
    const collections = await qdrant.getCollections();
    if (!collections.collections.some((c) => c.name === COLLECTION)) return;
    await qdrant.delete(COLLECTION, {
      wait: true,
      filter: {
        must: [
          { key: "project", match: { value: projectName } },
          { key: "file", match: { any: normalizedFiles } },
        ],
        must_not: [{ key: "type", match: { value: "decision" } }],
      },
    });
  };

  if (allChunks.length === 0) {
    await deleteOldFilePoints();
    console.log(`[incremental] ${projectName}: puntos removidos para ${normalizedFiles.length} archivo(s).`);
    return;
  }

  let expectedDim = null;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const vectors = await embed(batch.map((c) => c.text));

    if (expectedDim === null) {
      await ensureCollection(vectors[0].length);
      expectedDim = vectors[0].length;
      await deleteOldFilePoints();
    } else if (vectors[0].length !== expectedDim) {
      throw new Error(
        `El batch en el offset ${i} genero vectores de dimension ${vectors[0].length}, ` +
        `pero se esperaba ${expectedDim}.`
      );
    }

    const points = batch.map((c, idx) => ({
      id: stableId(projectName, c.metadata.file, c.metadata.startLine, c.metadata.endLine),
      vector: vectors[idx],
      payload: {
        text: c.text,
        ...c.metadata,
      },
    }));

    await qdrant.upsert(COLLECTION, { points });
  }

  console.log(`[incremental] ${projectName}: ${allChunks.length} chunk(s) actualizados de ${normalizedFiles.length} archivo(s).`);
}

async function main() {
  if (!PROJECTS_ROOT) {
    console.error("Falta PROJECTS_ROOT en .env");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const filesFlagIndex = args.indexOf("--files");
  const targetProject = filesFlagIndex === -1 ? args[0] : args[0] !== "--files" ? args[0] : null;
  const incrementalFiles = filesFlagIndex !== -1 ? args.slice(filesFlagIndex + 1) : null;

  if (incrementalFiles !== null) {
    if (!targetProject) {
      console.error("Uso: node src/indexer.js <proyecto> --files <archivo1> [archivo2 ...]");
      process.exit(1);
    }
    await indexProjectFiles(targetProject, path.join(PROJECTS_ROOT, targetProject), incrementalFiles);
    return;
  }

  const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
  const projectDirs = entries.filter((e) => e.isDirectory());

  for (const dir of projectDirs) {
    if (targetProject && dir.name !== targetProject) continue;
    await indexProject(dir.name, path.join(PROJECTS_ROOT, dir.name));
  }

  console.log("\nIndexado completo.");
}

main().catch((err) => {
  console.error("Error en indexado:", err);
  process.exit(1);
});
