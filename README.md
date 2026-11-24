# agent-memory

Base de conocimiento centralizada para que Claude Code, Codex y otros agentes
compartan memoria sobre tus proyectos Java/Spring Boot y .NET: busqueda
semantica sobre el codigo + registro de decisiones de arquitectura (ADRs)
indexadas.

## Como funciona

```
12 proyectos (carpetas)
        │
        ▼
  src/indexer.js  → chunkea por clase/metodo (Java) → embeddings → Qdrant
        │
        ▼
   Qdrant (vector DB, corre en Docker)
        │
   ┌────┴─────┐
   ▼          ▼
mcpServer.js   api.js
(Claude Code)  (Codex, agy, curl, cualquier agente HTTP)
```

Un solo indice, dos formas de acceder a el.

## Setup

### 1. Levantar Qdrant + Ollama

```bash
docker compose up -d     # la primera vez descarga nomic-embed-text (~275 MB)
docker compose stop      # cuando no lo uses: apaga Qdrant y Ollama
```

Ambos tienen que estar arriba tanto para indexar como para buscar (cada
pregunta se convierte en vector con Ollama). Ollama escucha solo en
`127.0.0.1:11434`. Si tenes Ollama instalado nativo, tiene que estar apagado
(usan el mismo puerto).

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Editar `.env`:
- `PROJECTS_ROOT`: carpeta que contiene tus 12 proyectos (una subcarpeta por proyecto)
- `EMBEDDINGS_PROVIDER`: proveedor principal. Default `ollama` (local, gratis, sin API key)
- `EMBEDDINGS_FALLBACK_PROVIDER`: proveedor de respaldo si el principal falla (opcional)

#### Proveedor de respaldo (ollama + voyage/openai)

Por default el sistema usa **Ollama local** (gratis, sin API key, viene en el
`docker-compose.yml`). Si querés un respaldo en
la nube por si Ollama no esta corriendo o falla, configura `VOYAGE_API_KEY` y
`EMBEDDINGS_FALLBACK_PROVIDER=voyage` — Voyage tiene tier gratuito.

**Ojo con las dimensiones:** cada proveedor genera vectores de un tamaño
distinto (`nomic-embed-text` = 768, `voyage-code-3` = 1024). Qdrant fija la
dimension de una coleccion al crearla, asi que si el principal y el fallback
tienen dimensiones distintas, el sistema va a **fallar explicitamente** en
vez de corromper el indice (ver validaciones en `indexer.js`). Dos formas
practicas de manejarlo:

1. **Recomendada:** usa el fallback solo para diagnostico. Si ves el error de
   dimension incompatible, es porque el principal esta caido — arreglalo y
   volve a indexar, en vez de dejar que el fallback reemplace silenciosamente
   al principal.
2. Si de verdad queres correr con dos proveedores en paralelo de forma
   estable, usa `QDRANT_COLLECTION` distinto para cada uno (ej.
   `code_knowledge_ollama` y `code_knowledge_voyage`) y que la API/MCP
   consulten la que corresponda.

### 4. Indexar

```bash
# Todos los proyectos
npm run index

# Un solo proyecto (util para probar primero)
node src/indexer.js nombre-del-proyecto
```

### 5. Conectar los agentes

**Claude Code (via MCP):**

```bash
claude mcp add agent-memory --scope user -- \
  node --env-file=/home/main/prg/romerd/agent-memory/.env \
  /home/main/prg/romerd/agent-memory/src/mcpServer.js
```

- `--scope user`: disponible en todos tus proyectos (sin el flag, solo en la carpeta actual).
- `--env-file` es obligatorio: Claude Code arranca el server desde la carpeta en la
  que estes trabajando, y `dotenv` busca el `.env` en el directorio actual. Sin el
  flag no lo encuentra y usa la coleccion por default (`code_knowledge`).
- Verificar con `claude mcp list` (debe decir `✔ Connected`) o `/mcp` dentro de una sesion.
- Despues de cambiar el codigo del server, reconectar desde `/mcp`.

Esto expone 3 tools: `search_codebase` (con filtro opcional `contains` para
palabras exactas como nombres de clientes o constantes), `get_project_context`,
`log_decision`.

**Codex / agy / cualquier agente con acceso a `curl` o HTTP:**

```bash
npm run api
```

Luego, desde el agente (o instrucciones/system prompt del agente):

```bash
# Buscar contexto relevante
curl "http://localhost:4500/search?q=como+se+valida+el+token+JWT&project=mi-proyecto"

# Mismo, pero solo fragmentos que contengan una palabra exacta (case-insensitive)
curl "http://localhost:4500/search?q=que+procesos+ejecuta+el+cliente&contains=TECHHUB"

# Contexto general de un proyecto al empezar sesion
curl "http://localhost:4500/projects/mi-proyecto/context"

# Registrar una decision nueva
curl -X POST http://localhost:4500/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "project": "mi-proyecto",
    "title": "Uso de MapStruct para DTOs",
    "context": "Necesitabamos mapear entidades a DTOs sin boilerplate manual",
    "decision": "Se adopto MapStruct en vez de mappers manuales o ModelMapper",
    "consequences": "Requiere build annotation processing; mas rapido en runtime que ModelMapper"
  }'
```

Para que Codex/agy lo usen automaticamente, agregales una instruccion en su
system prompt / config del tipo: *"Antes de modificar codigo, consulta
`GET http://localhost:4500/search?q=...` para entender el contexto existente.
Despues de resolver algo no trivial, registra un ADR con `POST /decisions`."*

## Mantenimiento (que no se desactualice)

Agregar un git hook `post-commit` en cada proyecto que reindexe solo lo que
cambio:

```bash
#!/bin/sh
# .git/hooks/post-commit en cada uno de los 12 proyectos
cd /ruta/a/agent-memory && node src/indexer.js $(basename $(git rev-parse --show-toplevel))
```

Esto reindexa el proyecto completo (rapido, porque `upsert` sobreescribe por
id estable). Si el volumen crece mucho, se puede optimizar para indexar solo
`git diff --name-only HEAD~1`.

## Extender el chunker

`src/chunker.js` usa un heuristico por regex para partir archivos `.java` y
`.cs` por clase/metodo, sin depender de gramaticas pesadas. Ambos lenguajes
comparten el mismo motor (`chunkByMemberRegex`), solo cambia el regex de
deteccion de miembros y el label de namespace (`package` en Java, `namespace`
en C#). Si mas adelante necesitas mayor precision (generics anidados raros,
records complejos), se puede reemplazar por `web-tree-sitter` con la
gramatica correspondiente sin tocar el resto del sistema — la interfaz
`chunkFile(path, content) -> chunks[]` se mantiene.

**Limitacion conocida:** cuando la firma de la clase matchea antes que un
metodo interno, el heuristico captura la clase completa (con todos sus
metodos) como un solo chunk, en vez de partir metodo por metodo. Para
controllers/services de tamano tipico esto funciona bien y hasta da mejor
contexto (ves la clase completa de una). Si tenes clases muy grandes (varios
cientos de lineas) y notas que la busqueda semantica pierde precision, es la
primera señal de que conviene migrar ese lenguaje a tree-sitter.

## Proximos pasos sugeridos

- [ ] Probar con 1 proyecto piloto antes de indexar los 12
- [ ] Ajustar `INCLUDE_PATTERNS` en `indexer.js` si usas Kotlin, `.sql`, etc.
- [ ] Agregar autenticacion basica a `api.js` si vas a exponerla mas alla de localhost
- [ ] Automatizar el reindexado con el git hook de arriba
