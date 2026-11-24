/**
 * Chunking "code-aware" sin depender de gramaticas pesadas.
 * Para Java parte por limites de clase/metodo (deteccion por firma + llaves balanceadas).
 * Para el resto (md, yml, properties, etc) usa chunks de tamano fijo con overlap.
 *
 * Nota: si mas adelante necesitas mayor precision (records, interfaces anidadas,
 * anotaciones multilinea raras), se puede reemplazar este heuristico por
 * web-tree-sitter + gramatica de Java sin cambiar la interfaz de esta funcion.
 */

const JAVA_MEMBER_REGEX =
  /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+\w+|^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],\s]+\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;

// C#: clases/interfaces/records/structs, y firmas de metodo o propiedad con cuerpo.
// Cubre modificadores tipicos de .NET (async, virtual, override, sealed, partial) y atributos [Attr].
const CSHARP_MEMBER_REGEX =
  /^\s*(?:\[\w+(?:\([^)]*\))?\]\s*)*(?:public|private|protected|internal)?\s*(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|enum|record|struct)\s+\w+|^\s*(?:\[\w+(?:\([^)]*\))?\]\s*)*(?:public|private|protected|internal)\s+(?:static\s+|virtual\s+|override\s+|async\s+|sealed\s+)*[\w<>\[\],?.]+\s+\w+\s*\([^)]*\)\s*\{/;

export function chunkFile(filePath, content) {
  if (filePath.endsWith(".java")) {
    return chunkJava(filePath, content);
  }
  if (filePath.endsWith(".cs")) {
    return chunkCSharp(filePath, content);
  }
  return chunkGeneric(filePath, content, 120, 20);
}

function chunkJava(filePath, content) {
  const packageMatch = content.match(/^\s*package\s+([\w.]+);/m);
  const namespace = packageMatch ? packageMatch[1] : "(default)";
  return chunkByMemberRegex(filePath, content, {
    memberRegex: JAVA_MEMBER_REGEX,
    namespace,
    namespaceLabel: "package",
    memberType: "java-member",
    headerType: "java-header",
  });
}

function chunkCSharp(filePath, content) {
  // Soporta tanto "namespace Foo.Bar { ... }" como file-scoped "namespace Foo.Bar;"
  const namespaceMatch = content.match(/^\s*namespace\s+([\w.]+)\s*[;{]/m);
  const namespace = namespaceMatch ? namespaceMatch[1] : "(default)";
  return chunkByMemberRegex(filePath, content, {
    memberRegex: CSHARP_MEMBER_REGEX,
    namespace,
    namespaceLabel: "namespace",
    memberType: "csharp-member",
    headerType: "csharp-header",
  });
}

/**
 * Recorre el archivo linea por linea, detecta inicios de miembro (clase/metodo)
 * con memberRegex y captura el bloque completo balanceando llaves.
 * Comun a Java y C#, que comparten sintaxis de bloques con { }.
 */
function chunkByMemberRegex(filePath, content, { memberRegex, namespace, namespaceLabel, memberType, headerType }) {
  const lines = content.split("\n");
  const chunks = [];

  let i = 0;
  while (i < lines.length && !memberRegex.test(lines[i])) {
    i++;
  }
  const headerEnd = i;
  const header = lines.slice(0, headerEnd).join("\n");

  while (i < lines.length) {
    if (memberRegex.test(lines[i])) {
      const start = i;
      let depth = 0;
      let started = false;
      while (i < lines.length) {
        for (const ch of lines[i]) {
          if (ch === "{") {
            depth++;
            started = true;
          } else if (ch === "}") {
            depth--;
          }
        }
        i++;
        if (started && depth <= 0) break;
      }
      chunks.push(
        ...pieces(
          `// ${namespaceLabel}: ${namespace}\n// archivo: ${filePath}\n`,
          lines.slice(start, i),
          start,
          { file: filePath, package: namespace, type: memberType },
          true
        )
      );
    } else {
      i++;
    }
  }

  if (chunks.length === 0) {
    return chunkGeneric(filePath, content, 120, 20);
  }

  if (header.trim().length > 0) {
    chunks.unshift(
      ...pieces(
        `// ${namespaceLabel}: ${namespace}\n// archivo: ${filePath} (usings/cabecera)\n`,
        lines.slice(0, headerEnd),
        0,
        { file: filePath, package: namespace, type: headerType },
        false
      )
    );
  }

  return chunks;
}

function chunkGeneric(filePath, content, chunkLines, overlapLines) {
  const lines = content.split("\n");
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + chunkLines, lines.length);
    const window = lines.slice(start, end);
    if (window.join("\n").trim().length > 0) {
      chunks.push(...pieces(`// archivo: ${filePath}\n`, window, start, { file: filePath, type: "generic" }, false));
    }
    if (end === lines.length) break;
    start = end - overlapLines;
  }
  return chunks;
}

// nomic-embed-text acepta 2048 tokens; ~4000 chars de codigo entra con margen.
export const MAX_CHARS = 4000;

/**
 * Parte un bloque de lineas en chunks de hasta MAX_CHARS, cortando de
 * preferencia en una linea en blanco (tipicamente entre metodos).
 * `start` es el indice 0-based de lines[0] dentro del archivo.
 * Si `continuation`, las partes 2..n llevan la firma original (ej. la clase)
 * para que la busqueda sepa de donde vienen.
 * ponytail: una sola linea > MAX_CHARS (JSON minificado) queda como chunk propio
 * y Ollama la trunca; si molesta, partirla por caracteres.
 */
function pieces(prefix, lines, start, metadata, continuation) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    let size = 0;
    let lastBlank = -1;
    while (j < lines.length && (j === i || size + lines[j].length + 1 <= MAX_CHARS)) {
      size += lines[j].length + 1;
      if (j > i && lines[j].trim() === "") lastBlank = j;
      j++;
    }
    if (j < lines.length && lastBlank > i + (j - i) / 2) j = lastBlank + 1;
    const cont = continuation && i > 0 ? `// (continuacion de: ${lines[0].trim()})\n` : "";
    out.push({
      text: prefix + cont + lines.slice(i, j).join("\n"),
      metadata: { ...metadata, startLine: start + i + 1, endLine: start + j },
    });
    i = j;
  }
  return out;
}
