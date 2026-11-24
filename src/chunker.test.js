import test from "node:test";
import assert from "node:assert/strict";
import { chunkFile, MAX_CHARS } from "./chunker.js";

const method = (n) => `    public int metodo${n}(int x) {\n        int y = x * ${n};\n        return y + ${n};\n    }\n`;

test("clase grande se parte en chunks chicos, contiguos y con la firma de la clase", () => {
  const body = Array.from({ length: 300 }, (_, n) => method(n)).join("\n");
  const src = `package com.ejemplo;\n\nimport java.util.List;\n\npublic class Grande {\n${body}}\n`;
  const chunks = chunkFile("Grande.java", src).filter((c) => c.metadata.type === "java-member");

  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.text.length <= MAX_CHARS + 300, `chunk de ${c.text.length} chars`);
  for (let k = 1; k < chunks.length; k++) {
    assert.equal(chunks[k].metadata.startLine, chunks[k - 1].metadata.endLine + 1);
    assert.match(chunks[k].text, /continuacion de: public class Grande/);
  }
  assert.equal(chunks[0].metadata.startLine, 5);
  assert.equal(chunks.at(-1).metadata.endLine, src.split("\n").length - 1);
  // corta entre metodos, no en el medio de uno
  for (const c of chunks.slice(0, -1)) assert.match(c.text, /}\n?$/);
});

test("clase chica queda en un solo chunk", () => {
  const src = `package a;\n\npublic class Chica {\n${method(1)}}\n`;
  const members = chunkFile("Chica.java", src).filter((c) => c.metadata.type === "java-member");
  assert.equal(members.length, 1);
  assert.doesNotMatch(members[0].text, /continuacion/);
});
