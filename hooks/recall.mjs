#!/usr/bin/env node
// Recall: BM25 over Claude Code transcripts, injected under a hard budget.
//
// Port of recall.py. Same behaviour, same decisions (docs/adr/), verified by
// comparing output against the Python implementation on the same corpus.
//
// Runs on any Node >= 14: no dependencies, and deliberately NOT node:sqlite,
// which needs Node >= 22.5 and would drop every user on 18 or 20. The index is
// a plain inverted index sharded by term prefix, so a lookup reads a handful of
// small files instead of loading the whole corpus per prompt.
//
// Everything fails open. A hook that cannot search must not stop the turn.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// Absolute path to this file, so messages we print can be pasted and run from
// anywhere. The plugin is installed under a cache directory the user never
// typed, so a bare "recall.mjs" would not resolve for them.
const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);

const HOME = os.homedir();
const ROOT = path.join(HOME, ".claude", "recall");
const CHUNKS = path.join(ROOT, "chunks.jsonl");
const OFFSETS = path.join(ROOT, "offsets.json");
const META = path.join(ROOT, "meta.json");
const SHARDS = path.join(ROOT, "idx");
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

const env = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const CHARS_PER_TOKEN = 3.3;
const BUDGET_TOKENS = env("RECALL_BUDGET_TOKENS", 400);
const PREVIEW_CHARS = env("RECALL_PREVIEW_CHARS", 220);
const MAX_HITS = env("RECALL_MAX_HITS", 4);
const MIN_COVERAGE = env("RECALL_MIN_COVERAGE", 0.5);
const COVERAGE_CEILING = env("RECALL_COVERAGE_CEILING", 3);
const COMMON_TERM_RATIO = env("RECALL_COMMON_TERM_RATIO", 0.15);

const TOOL_INPUT_CAP = 300;    // chars of a tool_use input kept per call
const TOOL_RESULT_CAP = 500;   // above this a tool result is a Volcado, not dialogue
const MAX_CHUNK_CHARS = 6000;  // an agentic turn can run tens of thousands of chars
const MIN_TERM_LEN = 4;
const MIN_TERMS = 2;

const STOPWORDS = new Set(`para porque pero como cuando donde esto esta este eso esa ese que los
las del con por una uno sobre entre hacer hace tiene tener puede poder todo toda todos cual quien
algo muy mas menos bien mal the this that with from have has was were what when where which there
their then than into about would could should does did you your and for not`.split(/\s+/));

// ------------------------------------------------------------------ storage

function ensureRoot() {
  fs.mkdirSync(SHARDS, { recursive: true });
}

// Null-prototype on purpose: shards are keyed by words from the corpus, and a
// word like "constructor" or "valueOf" would otherwise resolve against
// Object.prototype and hand back a function instead of a postings array.
function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.assign(Object.create(null), parsed)
      : parsed;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

// Two characters, so a shard holds a slice small enough to read per query.
// One character would make shards ~20x bigger; three would make thousands of
// tiny files, which is slower on Windows than reading a bit more data.
function shardName(term) {
  const key = (term.slice(0, 2).replace(/[^a-z0-9]/g, "_") || "__");
  return path.join(SHARDS, `${key}.json`);
}

function loadShard(term) {
  return readJson(shardName(term), Object.create(null));
}

// ------------------------------------------------------------------ project

export function resolveProject(cwd) {
  // Claude Code derives the directory name by replacing every non-alphanumeric
  // character with '-'. Windows resolves paths case-insensitively, so the
  // derived name can differ in case from what is on disk; storing the derived
  // spelling would file one project under two labels and break the filter.
  const key = cwd.replace(/[^A-Za-z0-9]/g, "-");
  try {
    for (const name of fs.readdirSync(PROJECTS_DIR)) {
      if (name.toLowerCase() === key.toLowerCase()) return name;
    }
  } catch { /* no projects dir yet */ }
  return key;
}

// ------------------------------------------------------------------ chunking

export function userText(content) {
  // A user entry carrying only tool_result blocks is the harness replying to
  // itself, not the person typing.
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const joined = content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .filter(Boolean).join("\n").trim();
  return joined || null;
}

export function toolResultText(content) {
  // ADR 0003 defines a Volcado by mass, so the test is size, not tool name:
  // this keeps file bodies and bash dumps out while keeping an
  // AskUserQuestion answer -- which is the person talking -- in.
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (!b || b.type !== "tool_result") continue;
    const inner = b.content;
    if (typeof inner === "string") parts.push(inner);
    else if (Array.isArray(inner)) {
      for (const x of inner) if (x && x.type === "text") parts.push(x.text || "");
    }
  }
  const joined = parts.filter(Boolean).join("\n").trim();
  if (!joined || joined.length > TOOL_RESULT_CAP) return null;
  return joined;
}

export function assistantParts(content) {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === "text") {
      if ((b.text || "").trim()) out.push(b.text);
    } else if (b.type === "tool_use") {
      // Inputs say what was attempted and where: the highest signal per byte
      // in a transcript. Outputs are not.
      let raw = JSON.stringify(b.input || {});
      if (raw.length > TOOL_INPUT_CAP) raw = raw.slice(0, TOOL_INPUT_CAP) + "...";
      out.push(`[${b.name || "tool"}] ${raw}`);
    }
  }
  return out;
}

export function splitTurn(user, parts) {
  // An agentic turn is not conversation-sized. Left whole it blows the
  // injection budget in one hit; every piece repeats the user's words so it
  // still means something when retrieved alone.
  const head = user ? user + "\n" : "";
  const chunks = [];
  let cur = [], size = head.length;
  for (let p of parts) {
    if (p.length > MAX_CHUNK_CHARS) p = p.slice(0, MAX_CHUNK_CHARS) + "\n[...recortado]";
    if (cur.length && size + p.length > MAX_CHUNK_CHARS) {
      chunks.push(head + cur.join("\n"));
      cur = []; size = head.length;
    }
    cur.push(p);
    size += p.length + 1;
  }
  if (cur.length || !chunks.length) chunks.push(head + cur.join("\n"));
  return chunks.filter((c) => c.trim());
}

// Reads new bytes of one transcript and yields complete turns.
// The trailing turn is withheld: it may still be growing, so `resume` points at
// its start and the next run re-reads it once it is finished.
async function readNewChunks(file, startOffset) {
  const session = path.basename(file).replace(/\.jsonl$/, "");
  const out = [];
  let curUser = null, buf = [], seen = new Set(), chunkStart = startOffset;
  let ts = "", resume = startOffset, pos = startOffset;

  const flush = () => {
    if (!curUser && !buf.length) return;
    for (const text of splitTurn(curUser, buf)) out.push({ text, session, ts });
    resume = chunkStart;
  };

  const stream = fs.createReadStream(file, { start: startOffset, encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const lineStart = pos;
    pos += Buffer.byteLength(line, "utf8") + 1; // +1: the newline readline strips
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "user") {
      // Harness-injected, not the person: skill bodies, reminders. One skill
      // body measured 862,714 chars and swallowed the turn around it.
      if (d.isMeta) continue;
      const content = (d.message || {}).content;
      const text = userText(content);
      if (text === null) {
        const res = toolResultText(content);
        if (res) buf.push(`[resultado] ${res}`);
        continue;
      }
      flush();
      resume = lineStart;
      curUser = text; buf = []; chunkStart = lineStart; ts = d.timestamp || "";
    } else if (d.type === "assistant") {
      const msg = d.message || {};
      const key = d.requestId || msg.id;
      if (key && seen.has(key)) continue; // streaming writes each response 2-3x
      if (key) seen.add(key);
      buf.push(...assistantParts(msg.content));
      if (!ts) ts = d.timestamp || "";
    }
  }
  return { chunks: out, resume: buf.length || curUser ? chunkStart : pos };
}

// ------------------------------------------------------------------ indexing

export function termsOf(text) {
  const out = [], seen = new Set();
  for (const raw of text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) || []) {
    const w = raw.replace(/^[./_-]+|[./_-]+$/g, "");
    if (w.length < MIN_TERM_LEN || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
  }
  return out;
}

// Every distinct word of a chunk with its count, for BM25.
function chunkTerms(text) {
  const tf = new Map();
  for (const raw of text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) || []) {
    const w = raw.replace(/^[./_-]+|[./_-]+$/g, "");
    if (w.length < MIN_TERM_LEN || STOPWORDS.has(w)) continue;
    tf.set(w, (tf.get(w) || 0) + 1);
  }
  return tf;
}

export function cmdIndex(cwd, all = false) {
  ensureRoot();
  const meta = readJson(META, { docs: 0, totalLen: 0, files: {} });
  const offsets = readJson(OFFSETS, []);
  const dirs = all
    ? fs.readdirSync(PROJECTS_DIR).map((d) => path.join(PROJECTS_DIR, d))
    : [path.join(PROJECTS_DIR, resolveProject(cwd))];

  const pending = new Map(); // shard -> {term: postings}
  let added = 0;
  const appends = [];
  // Byte offset of each record, so a lookup seeks instead of scanning. Without
  // this, every search reads the whole corpus: 46 MB per prompt at 10k chunks,
  // and linearly worse as it grows.
  let tail = 0;
  try { tail = fs.statSync(CHUNKS).size; } catch { /* first run */ }

  const run = async () => {
    for (const dir of dirs) {
      let files;
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); }
      catch { continue; }
      const project = path.basename(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        let start = meta.files[full] || 0;
        let size;
        try { size = fs.statSync(full).size; } catch { continue; }
        if (size < start) start = 0; // truncated or replaced: reindex
        if (size === start) continue;
        const { chunks, resume } = await readNewChunks(full, start);
        for (const c of chunks) {
          const id = meta.docs++;
          const rec = JSON.stringify({ id, project, session: c.session, ts: c.ts, text: c.text });
          appends.push(rec);
          const bytes = Buffer.byteLength(rec, "utf8");
          const tf = chunkTerms(c.text);
          meta.totalLen += tf.size;
          offsets[id] = [tail, bytes, tf.size];
          tail += bytes + 1; // +1 for the newline joined in on append
          for (const [term, n] of tf) {
            const s = shardName(term);
            if (!pending.has(s)) pending.set(s, null);
            const bucket = pending.get(s) || Object.create(null);
            (bucket[term] ||= []).push([id, n]);
            pending.set(s, bucket);
          }
          added++;
        }
        meta.files[full] = resume;
      }
    }
  };

  return run().then(() => {
    if (appends.length) fs.appendFileSync(CHUNKS, appends.join("\n") + "\n");
    for (const [file, bucket] of pending) {
      if (!bucket) continue;
      const shard = readJson(file, Object.create(null));
      for (const [term, postings] of Object.entries(bucket)) {
        (shard[term] ||= []).push(...postings);
      }
      writeJson(file, shard);
    }
    writeJson(META, meta);
    writeJson(OFFSETS, offsets);
    return added;
  });
}

// ------------------------------------------------------------------ retrieval

function postingsFor(terms) {
  const byShard = new Map();
  for (const t of terms) {
    const s = shardName(t);
    if (!byShard.has(s)) byShard.set(s, []);
    byShard.get(s).push(t);
  }
  const out = new Map();
  for (const [file, group] of byShard) {
    const shard = readJson(file, Object.create(null));
    for (const t of group) out.set(t, shard[t] || []);
  }
  return out;
}

export function usableTerms(rawTerms, postings, docs) {
  // A term present in a large share of the corpus carries no location
  // information: matching it says nothing about where the answer is.
  const cap = Math.max(20, Math.floor(docs * COMMON_TERM_RATIO));
  return rawTerms.filter((t) => {
    const df = (postings.get(t) || []).length;
    return df > 0 && df <= cap;
  });
}

export function covered(text, terms) {
  // Whole words, not substrings: 'color' is inside 'colored', 'tengo' inside
  // 'mantengo', and substring matching inflates coverage on exactly the
  // queries the gate exists to reject.
  const words = new Set(
    (text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) || [])
      .map((w) => w.replace(/^[./_-]+|[./_-]+$/g, ""))
  );
  return terms.filter((t) => words.has(t)).length;
}

function bm25(terms, postings, docs, avgdl, lens) {
  const k1 = 1.2, b = 0.75;
  const scores = new Map();
  for (const t of terms) {
    const list = postings.get(t) || [];
    if (!list.length) continue;
    const idf = Math.log(1 + (docs - list.length + 0.5) / (list.length + 0.5));
    for (const [id, tf] of list) {
      const dl = (lens[id] && lens[id][2]) || avgdl;
      const denom = tf + k1 * (1 - b + (b * dl) / avgdl);
      scores.set(id, (scores.get(id) || 0) + (idf * tf * (k1 + 1)) / denom);
    }
  }
  return scores;
}

// A search reads up to a few dozen candidates by byte offset. Opening and
// closing the file per candidate costs more than the reads themselves, so the
// caller opens once and passes the handle down.
function openChunks() {
  try { return fs.openSync(CHUNKS, "r"); } catch { return null; }
}

function readChunkAt(fd, entry) {
  if (fd === null || !entry) return null;
  const [off, len] = entry;
  try {
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, off);
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

function readChunk(id, offsets) {
  const fd = openChunks();
  if (fd === null) return null;
  try {
    return readChunkAt(fd, (offsets || readJson(OFFSETS, []))[id]);
  } finally {
    fs.closeSync(fd);
  }
}

export function search(prompt, project, excludeSession, limit = MAX_HITS,
                       minCoverage = MIN_COVERAGE) {
  const meta = readJson(META, { docs: 0, totalLen: 0, files: {} });
  if (!meta.docs) return [];
  const lens = readJson(OFFSETS, []);
  const raw = termsOf(prompt);
  if (!raw.length) return [];
  const postings = postingsFor(raw);
  const terms = usableTerms(raw, postings, meta.docs);
  if (terms.length < MIN_TERMS) return [];

  const avgdl = meta.totalLen / meta.docs || 1;
  const scores = bm25(terms, postings, meta.docs, avgdl, lens);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit * 8);

  // Capped on purpose: without the ceiling the bar rises with every extra rare
  // word, so a longer question retrieves less than a shorter one asking the
  // same thing. Two rare terms co-occurring is already strong evidence.
  const need = Math.max(MIN_TERMS,
    Math.min(COVERAGE_CEILING, Math.ceil(terms.length * minCoverage)));

  const hits = [];
  const fd = openChunks();
  try {
    for (const [id, score] of ranked) {
      const rec = readChunkAt(fd, lens[id]);
      if (!rec) continue;
      if (project && rec.project !== project) continue;
      if (excludeSession && rec.session === excludeSession) continue;
      if (covered(rec.text, terms) < need) continue;
      hits.push({ ...rec, score: -score });
      if (hits.length >= limit) break;
    }
  } finally {
    if (fd) fs.closeSync(fd);
  }
  return hits;
}

// ------------------------------------------------------------------ output

export function firstLine(text) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

export function renderPointers(hits, budgetTokens = BUDGET_TOKENS) {
  // Pointers, not bodies: the verbatim text is one `show` away and is pulled
  // only for the hits that turn out to matter (ADR 0005).
  const cap = Math.floor(budgetTokens * CHARS_PER_TOKEN);
  const out = [];
  let spent = 0;
  for (const h of hits) {
    const head = firstLine(h.text).slice(0, PREVIEW_CHARS);
    const line = `  #${h.id} | ${(h.ts || "").slice(0, 10)} | sesion ${h.session.slice(0, 8)} | ${head}`;
    if (spent + line.length > cap) break;
    out.push(line);
    spent += line.length;
  }
  return out;
}

function cmdInject(payload) {
  const cwd = payload.cwd || process.cwd();
  const hits = search(String(payload.prompt || ""), resolveProject(cwd),
                      payload.session_id || "");
  const lines = renderPointers(hits);
  if (!lines.length) return; // nothing worth paying for
  console.log("<recall> Turnos de sesiones anteriores de este proyecto cuyos terminos " +
    "coinciden con tu mensaje. Solo el encabezado -- para leer el texto verbatim de " +
    `alguno, corre: node "${SELF}" show <id> [<id>...]`);
  console.log(lines.join("\n"));
  console.log("</recall>");
}

function cmdShow(args) {
  const ids = args.filter((a) => /^#?\d+$/.test(a)).slice(0, 6);
  if (!ids.length) { console.log(`uso: node "${SELF}" show <id> [<id>...]`); return; }
  for (const raw of ids) {
    const rec = readChunk(Number(raw.replace("#", "")));
    if (!rec) { console.log(`\n=== #${raw}: no existe ===`); continue; }
    console.log(`\n=== #${rec.id} | ${rec.project} | sesion ${rec.session.slice(0, 8)} | ${(rec.ts || "").slice(0, 16)} ===\n${rec.text}`);
  }
}

function cmdSearch(args) {
  const global = args.includes("--global");
  const query = args.filter((a) => a !== "--global").join(" ").trim();
  if (!query) { console.log("uso: recall.mjs search [--global] <consulta>"); return; }
  const hits = search(query, global ? null : resolveProject(process.cwd()), null, 10, 0.34);
  if (!hits.length) { console.log("Sin resultados."); return; }
  for (const h of hits) {
    const body = h.text.length <= 1200 ? h.text : h.text.slice(0, 1200) + "\n[...]";
    console.log(`\n=== #${h.id} | sesion ${h.session.slice(0, 8)} | ${(h.ts || "").slice(0, 16)} | score ${h.score.toFixed(2)} ===\n${body}`);
  }
}

const TOOL_RE = /^\[(\w+)\] (\{.*)$/gm;

function cmdSessions(args) {
  // Derived, never stored: a digest is a scan, so it cannot drift out of sync
  // with the transcript and costs no disk. Nothing is generated either -- the
  // ask is the user's own first line, files and commands come out of the tool
  // inputs (ADR 0001 applies to summaries too).
  const global = args.includes("--global");
  const needle = args.filter((a) => a !== "--global").join(" ").trim().toLowerCase();
  const project = global ? null : resolveProject(process.cwd());
  let lines;
  try { lines = fs.readFileSync(CHUNKS, "utf8").split("\n"); } catch { lines = []; }

  const bySession = new Map();
  for (const line of lines) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (project && rec.project !== project) continue;
    const key = `${rec.project}${rec.session}`;
    if (!bySession.has(key)) {
      bySession.set(key, { project: rec.project, session: rec.session, ts: rec.ts,
                           turns: 0, ask: firstLine(rec.text).slice(0, 160),
                           files: [], cmds: [] });
    }
    const d = bySession.get(key);
    d.turns++;
    TOOL_RE.lastIndex = 0;
    let m;
    while ((m = TOOL_RE.exec(rec.text)) !== null) {
      let input;
      try { input = JSON.parse(m[2].replace(/[.\s]+$/, "")); } catch { continue; }
      if (["Edit", "Write", "Read", "NotebookEdit"].includes(m[1])) {
        const p = input.file_path;
        if (p && !d.files.includes(p) && d.files.length < 8) d.files.push(p);
      } else if (["Bash", "PowerShell"].includes(m[1])) {
        const c = (input.command || "").trim().split("\n")[0];
        if (c && !d.cmds.includes(c) && d.cmds.length < 6) d.cmds.push(c.slice(0, 70));
      }
    }
  }

  const out = [...bySession.values()]
    .filter((d) => !needle || JSON.stringify(d).toLowerCase().includes(needle))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, 15);
  if (!out.length) { console.log("Sin sesiones que coincidan."); return; }
  for (const d of out) {
    console.log(`\n=== ${(d.ts || "").slice(0, 16)} | sesion ${d.session.slice(0, 8)} | ${d.turns} turnos${project ? "" : " | " + d.project}`);
    console.log(`    pidio: ${d.ask}`);
    if (d.files.length) console.log(`    archivos: ${d.files.map((f) => path.basename(f)).join(", ")}`);
    if (d.cmds.length) console.log(`    comandos: ${d.cmds.slice(0, 3).join(" | ")}`);
  }
}

function cmdRules() {
  // Next to this file, or one level up: the plugin layout puts hooks/ under
  // the plugin root while ground_rules.md sits at the root, and a standalone
  // checkout keeps them side by side.
  let body;
  for (const f of [path.join(HERE, "ground_rules.md"), path.join(HERE, "..", "ground_rules.md")]) {
    try { body = fs.readFileSync(f, "utf8"); break; } catch { /* try next */ }
  }
  if (!body) return;
  const parts = body.split("---");
  const rules = (parts.length > 1 ? parts[parts.length - 1] : body).trim();
  if (rules) { console.log("<ground_rules>"); console.log(rules); console.log("</ground_rules>"); }
}

function cmdStats() {
  const meta = readJson(META, { docs: 0, files: {} });
  let bytes = 0;
  try { bytes = fs.statSync(CHUNKS).size; } catch { /* no index yet */ }
  console.log(`chunks=${meta.docs}  archivos=${Object.keys(meta.files).length}  datos=${bytes} B  (${ROOT})`);
}

// ------------------------------------------------------------------ selftest

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-"));
  const file = path.join(tmp, "sess.jsonl");
  const L = (o) => JSON.stringify(o) + "\n";
  fs.writeFileSync(file, [
    L({ type: "user", timestamp: "2026-01-01T00:00:00Z",
        message: { content: [{ type: "text", text: "arreglar el deploy" }] } }),
    L({ type: "assistant", requestId: "r1", message: { content: [
        { type: "text", text: "miro el pipeline" },
        { type: "tool_use", name: "Bash", input: { command: "kubectl rollout status" } }] } }),
    L({ type: "assistant", requestId: "r1",
        message: { content: [{ type: "text", text: "DUPLICADO POR STREAMING" }] } }),
    L({ type: "user", message: { content: [
        { type: "tool_result", content: [{ type: "text", text: "opcion B" }] }] } }),
    L({ type: "user", message: { content: [
        { type: "tool_result", content: [{ type: "text", text: "Z".repeat(9000) }] }] } }),
    L({ type: "user", isMeta: true,
        message: { content: [{ type: "text", text: "SKILL " + "Y".repeat(90000) }] } }),
    L({ type: "user", timestamp: "2026-01-01T00:01:00Z",
        message: { content: [{ type: "text", text: "segundo pedido" }] } }),
    L({ type: "assistant", requestId: "r2",
        message: { content: [{ type: "text", text: "listo" }] } }),
  ].join(""));

  const { chunks, resume } = await readNewChunks(file, 0);
  assert(chunks.length === 1, `la vuelta abierta no debe indexarse: ${chunks.length}`);
  const body = chunks[0].text;
  assert(body.includes("arreglar el deploy") && body.includes("kubectl rollout status"),
    "perdio el pedido o el comando");
  assert(!body.includes("DUPLICADO POR STREAMING"), "no deduplico el streaming");
  assert(body.includes("opcion B"), "perdio una respuesta de AskUserQuestion");
  assert(!body.includes("ZZZ"), "indexo un Volcado");
  assert(!body.includes("YYY"), "indexo un cuerpo de skill (isMeta)");
  assert(body.length < MAX_CHUNK_CHARS + 200, `chunk sin acotar: ${body.length}`);

  const again = await readNewChunks(file, resume);
  assert(again.chunks.length === 0, "reindexo lo ya emitido");

  assert(splitTurn("u", ["a".repeat(5000), "b".repeat(5000)]).length === 2,
    "no partio la vuelta larga");
  assert(covered("el timeout de socket", ["timeout", "socket"]) === 2, "cobertura mal contada");
  assert(covered("colored mantengo", ["color", "tengo"]) === 0, "conto substrings");
  assert(JSON.stringify(termsOf("el timeout de socket")) === JSON.stringify(["timeout", "socket"]),
    "termsOf no filtro stopwords");

  const ptrs = renderPointers(
    Array.from({ length: 40 }, (_, i) => ({ id: i, text: `titulo ${i}\n` + "x".repeat(9000),
      session: "sess", ts: "2026-01-01" })), 100);
  assert(ptrs.length > 0, "no genero punteros");
  assert(ptrs.join("").length <= Math.floor(100 * CHARS_PER_TOKEN), "presupuesto no respetado");
  assert(!ptrs.some((p) => p.includes("x".repeat(50))), "el puntero arrastro el cuerpo");

  console.log("OK: selftest passed");
}

function assert(cond, msg) { if (!cond) { throw new Error(msg); } }

// ------------------------------------------------------------------ dispatch

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "--selftest") return selftest();
  if (cmd === "index") return console.log(`chunks nuevos: ${await cmdIndex(process.cwd(), args.includes("--all"))}`);
  if (cmd === "hook-index") {
    const payload = await readStdin();
    return void (await cmdIndex(payload.cwd || process.cwd(), false));
  }
  if (cmd === "inject") return cmdInject(await readStdin());
  if (cmd === "show") return cmdShow(args);
  if (cmd === "search") return cmdSearch(args);
  if (cmd === "sessions") return cmdSessions(args);
  if (cmd === "rules") return cmdRules();
  if (cmd === "stats") return cmdStats();
  console.log("uso: recall.mjs [index|inject|show|search|sessions|rules|stats|--selftest]");
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    setTimeout(() => resolve({}), 5000).unref?.();
  });
}

main().catch((e) => {
  // Fail open: a broken index must never block a turn.
  process.stderr.write(`recall: ${e.message}\n`);
  process.exit(0);
});
