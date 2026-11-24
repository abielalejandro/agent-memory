import "dotenv/config";
import express from "express";
import cors from "cors";
import { searchCodebase, getProjectContext, logDecision } from "./knowledge.js";

const app = express();
app.use(cors());
app.use(express.json());

// GET /search?q=...&project=...&limit=8&contains=TECHHUB
app.get("/search", async (req, res) => {
  try {
    const { q, project, limit, contains } = req.query;
    if (!q) return res.status(400).json({ error: "Falta parametro q" });
    const results = await searchCodebase(q, {
      project,
      contains,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /projects/:project/context
app.get("/projects/:project/context", async (req, res) => {
  try {
    const context = await getProjectContext(req.params.project);
    res.json({ project: req.params.project, context });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /decisions  { project, title, context, decision, consequences }
app.post("/decisions", async (req, res) => {
  try {
    const { project, title, context, decision, consequences } = req.body;
    if (!project || !title || !decision) {
      return res.status(400).json({ error: "Se requiere project, title y decision" });
    }
    const saved = await logDecision({ project, title, context, decision, consequences });
    res.status(201).json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 4500;
app.listen(port, () => {
  console.log(`Agent Memory API escuchando en http://localhost:${port}`);
  console.log(`  GET  /search?q=...&project=...&contains=...`);
  console.log(`  GET  /projects/:project/context`);
  console.log(`  POST /decisions`);
});
