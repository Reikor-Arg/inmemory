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
import { spawnSync } from "node:child_process";

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

// One scan of the corpus, shared by every reporting command below.
//
// Everything here is derived, never stored: a report is a scan, so it cannot
// drift out of sync with the transcript and costs no disk. Nothing is generated
// either -- the ask is the user's own first line, files and commands come out
// of the tool inputs. ADR 0001 applies to reports too: no model writes any of
// this, so none of it can be wrong in a way the transcript would contradict.
export function scanSessions(project) {
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
                           asks: [], files: [], cmds: [] });
    }
    const d = bySession.get(key);
    d.turns++;
    if (d.asks.length < 40) {
      const head = firstLine(rec.text).slice(0, 200);
      if (head && !d.asks.includes(head)) d.asks.push(head);
    }
    TOOL_RE.lastIndex = 0;
    let m;
    while ((m = TOOL_RE.exec(rec.text)) !== null) {
      let input;
      try { input = JSON.parse(m[2].replace(/[.\s]+$/, "")); } catch { continue; }
      if (["Edit", "Write", "Read", "NotebookEdit"].includes(m[1])) {
        const p = input.file_path;
        if (p && !d.files.includes(p) && d.files.length < 40) d.files.push(p);
      } else if (["Bash", "PowerShell"].includes(m[1])) {
        const c = (input.command || "").trim().split("\n")[0];
        if (c && !d.cmds.includes(c) && d.cmds.length < 40) d.cmds.push(c.slice(0, 70));
      }
    }
  }
  return [...bySession.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

const scopeOf = (args) =>
  args.includes("--global") ? null : resolveProject(process.cwd());
const restOf = (args) => args.filter((a) => !a.startsWith("--")).join(" ").trim().toLowerCase();

function cmdSessions(args) {
  const project = scopeOf(args);
  const needle = restOf(args);
  const out = scanSessions(project)
    .filter((d) => !needle || JSON.stringify(d).toLowerCase().includes(needle))
    .slice(0, 15);
  if (!out.length) { console.log("No matching sessions."); return; }
  for (const d of out) {
    console.log(`\n=== ${(d.ts || "").slice(0, 16)} | session ${d.session.slice(0, 8)} | ${d.turns} turns${project ? "" : " | " + d.project}`);
    console.log(`    asked: ${d.ask}`);
    if (d.files.length) console.log(`    files: ${d.files.slice(0, 8).map((f) => path.basename(f)).join(", ")}`);
    if (d.cmds.length) console.log(`    commands: ${d.cmds.slice(0, 3).join(" | ")}`);
  }
}

// ISO week, so digests line up with how people actually talk about "last week".
function isoWeek(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return "unknown";
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // Thursday decides the year
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - start) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function cmdTimeline(args) {
  const project = scopeOf(args);
  const limitArg = args.find((a) => /^--limit=\d+$/.test(a));
  const max = limitArg ? Number(limitArg.split("=")[1]) : 40;
  const sessions = scanSessions(project);
  if (!sessions.length) { console.log("Nothing indexed yet. Run: index --all"); return; }

  const byWeek = new Map();
  for (const s of sessions) {
    const w = isoWeek(s.ts);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(s);
  }
  let shown = 0;
  for (const [week, group] of byWeek) {
    if (shown >= max) break;
    const turns = group.reduce((n, s) => n + s.turns, 0);
    const files = new Set(group.flatMap((s) => s.files.map((f) => path.basename(f))));
    console.log(`\n## ${week}  --  ${group.length} session(s), ${turns} turns, ${files.size} file(s) touched`);
    for (const s of group) {
      if (shown++ >= max) break;
      console.log(`  ${(s.ts || "").slice(0, 10)} | ${s.session.slice(0, 8)} | ${s.ask.slice(0, 110)}`);
    }
  }
  console.log(`\n(${sessions.length} sessions total${project ? " in this project" : " across all projects"})`);
}

function cmdDigest(args) {
  const project = scopeOf(args);
  const want = args.find((a) => /^\d{4}-W\d{2}$/i.test(a));
  const sessions = scanSessions(project);
  if (!sessions.length) { console.log("Nothing indexed yet. Run: index --all"); return; }

  const week = want ? want.toUpperCase() : isoWeek(sessions[0].ts);
  const group = sessions.filter((s) => isoWeek(s.ts) === week);
  if (!group.length) {
    const weeks = [...new Set(sessions.map((s) => isoWeek(s.ts)))].slice(0, 8);
    console.log(`No sessions in ${week}. Available: ${weeks.join(", ")}`);
    return;
  }

  // Ranked by how many sessions touched them: what recurred is what the week
  // was actually about, which a single session's list cannot show.
  const rank = (pick) => {
    const count = new Map();
    for (const s of group) for (const v of new Set(pick(s))) count.set(v, (count.get(v) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]);
  };

  const turns = group.reduce((n, s) => n + s.turns, 0);
  console.log(`# ${week}${project ? ` -- ${project}` : ""}`);
  console.log(`${group.length} session(s), ${turns} turns\n`);

  console.log("## What was asked (verbatim, first line of each turn)");
  for (const s of group) {
    console.log(`\n- ${(s.ts || "").slice(0, 10)} (${s.session.slice(0, 8)})`);
    for (const a of s.asks.slice(0, 6)) console.log(`    ${a}`);
  }

  const files = rank((s) => s.files.map((f) => path.basename(f))).slice(0, 15);
  if (files.length) {
    console.log("\n## Files touched (sessions that touched each)");
    for (const [f, n] of files) console.log(`  ${String(n).padStart(3)}x  ${f}`);
  }
  const cmds = rank((s) => s.cmds.map((c) => c.split(/\s+/)[0])).slice(0, 12);
  if (cmds.length) {
    console.log("\n## Commands run");
    for (const [c, n] of cmds) console.log(`  ${String(n).padStart(3)}x  ${c}`);
  }
  console.log("\n(Verbatim material for a narrative. Nothing here was generated by a model.)");
}

function cmdTopics(args) {
  // A theme is what this project talks about and others do not. Raw frequency
  // cannot see that: it returns "error", "necesito", "true" -- words every
  // project uses. The contrast against the rest of the corpus is what separates
  // a subject from vocabulary, so this is per-project by construction and
  // --global is meaningless here.
  const project = resolveProject(process.cwd());
  const topArg = args.find((a) => /^--top=\d+$/.test(a));
  const top = topArg ? Number(topArg.split("=")[1]) : 20;

  let lines;
  try { lines = fs.readFileSync(CHUNKS, "utf8").split("\n"); } catch { lines = []; }
  const here = new Map(), everywhere = new Map();
  const hereSessions = new Set();
  for (const line of lines) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const mine = rec.project === project;
    if (mine) hereSessions.add(rec.session);
    for (const w of new Set(termsOf(rec.text))) {
      if (/^[\d._-]+$/.test(w)) continue;
      const g = everywhere.get(w) || new Set();
      g.add(rec.project); everywhere.set(w, g);
      if (mine) {
        const h = here.get(w) || new Set();
        h.add(rec.session); here.set(w, h);
      }
    }
  }
  if (hereSessions.size < 2) {
    console.log("Not enough history in this project yet for themes.");
    return;
  }

  const out = [...here.entries()]
    .map(([w, s]) => [w, s.size, (everywhere.get(w) || new Set()).size])
    .filter(([, mine]) => mine >= 2)
    // Present in few other projects: that is what makes it this project's
    // subject rather than everyone's filler.
    .filter(([, , projects]) => projects <= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
  if (!out.length) { console.log("No distinctive themes found yet."); return; }

  console.log(`Themes distinctive to this project (${hereSessions.size} sessions):
`);
  for (const [term, mine, projects] of out) {
    console.log(`  ${String(mine).padStart(4)} sessions here | ${projects} project(s) total  ${term}`);
  }
  console.log(`
Search any of them: search <term>`);
}

// ------------------------------------------------------------------ code map

// One regex per language for *declarations only*. Deliberately shallow: this is
// a map, not a parser. A tree-sitter grammar would be more accurate and would
// also be a native dependency, which is the one thing this plugin refuses to
// have. Missing an exotic declaration costs a line in an overview; requiring a
// compiler at install time costs the user entirely.
const SYMBOL_RES = [
  [/\.(m|c)?[jt]sx?$/, /^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm],
  [/\.(m|c)?[jt]sx?$/, /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm],
  [/\.py$/, /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/gm],
  [/\.go$/, /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm],
  [/\.(php|inc)$/, /^\s*(?:abstract\s+|final\s+)?(?:function|class|trait|interface)\s+([A-Za-z_][\w]*)/gm],
  [/\.(rb)$/, /^\s*(?:def|class|module)\s+([A-Za-z_][\w:]*)/gm],
  [/\.(java|kt|cs)$/, /^\s*(?:public|private|protected|internal)?[\w\s<>\[\]]*?(?:class|interface|record|fun)\s+([A-Za-z_][\w]*)/gm],
  [/\.(sh|bash)$/, /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm],
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor",
  "__pycache__", ".venv", "venv", "target", ".next", "coverage", ".cache"]);
const MAX_FILE_BYTES = 400_000;

function mapPath(project) {
  return path.join(ROOT, `map-${project}.json`);
}

function scanRepo(root) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile()) {
        files.push(full);
      }
    }
  };
  walk(root, 0);

  const out = [];
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join("/");
    let size;
    try { size = fs.statSync(full).size; } catch { continue; }
    const symbols = [];
    if (size <= MAX_FILE_BYTES) {
      let text = null;
      for (const [ext, re] of SYMBOL_RES) {
        if (!ext.test(rel)) continue;
        if (text === null) {
          try { text = fs.readFileSync(full, "utf8"); } catch { text = ""; }
        }
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (m[1] && !symbols.includes(m[1]) && symbols.length < 60) symbols.push(m[1]);
        }
      }
    }
    out.push({ path: rel, size, symbols });
  }
  return out;
}

function cmdMap(args) {
  const project = resolveProject(process.cwd());
  const file = mapPath(project);
  const refresh = args.includes("--refresh") || !fs.existsSync(file);
  const needle = args.filter((a) => !a.startsWith("--")).join(" ").trim().toLowerCase();

  let data;
  if (refresh) {
    ensureRoot();
    data = { root: process.cwd(), scannedAt: new Date().toISOString(), files: scanRepo(process.cwd()) };
    writeJson(file, data);
  } else {
    data = readJson(file, null);
    if (!data) { console.log("No map yet. Run: map --refresh"); return; }
  }

  const files = data.files || [];
  if (!files.length) { console.log("No source files found under " + data.root); return; }

  if (needle) {
    // Looking for one thing: answer where it is, not what the project looks like.
    const hits = files.filter((f) =>
      f.path.toLowerCase().includes(needle) ||
      f.symbols.some((s) => s.toLowerCase().includes(needle)));
    if (!hits.length) { console.log(`No file or symbol matching "${needle}".`); return; }
    for (const f of hits.slice(0, 25)) {
      const matched = f.symbols.filter((s) => s.toLowerCase().includes(needle));
      console.log(`  ${f.path}${matched.length ? "  ->  " + matched.slice(0, 8).join(", ") : ""}`);
    }
    return;
  }

  const byDir = new Map();
  for (const f of files) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  const total = files.reduce((n, f) => n + f.symbols.length, 0);
  console.log(`${data.root}`);
  console.log(`${files.length} files, ${total} declarations, scanned ${data.scannedAt.slice(0, 16)}
`);
  for (const [dir, group] of [...byDir.entries()].sort()) {
    const syms = group.reduce((n, f) => n + f.symbols.length, 0);
    console.log(`${dir}/  (${group.length} files${syms ? `, ${syms} declarations` : ""})`);
    for (const f of group.sort((a, b) => b.symbols.length - a.symbols.length).slice(0, 6)) {
      const name = f.path.split("/").pop();
      console.log(`    ${name}${f.symbols.length ? "  " + f.symbols.slice(0, 6).join(", ") : ""}`);
    }
    if (group.length > 6) console.log(`    ... ${group.length - 6} more`);
  }
  console.log(`
Stale? Re-run with --refresh. Find one thing: map <name>`);
}

// ------------------------------------------------------------- duplication

// Names so common that repetition carries no information: every module has a
// main, a handler, a setup. Reporting them buries the ones that matter.
const UBIQUITOUS = new Set(["main", "init", "setup", "run", "start", "stop",
  "test", "handler", "handle", "index", "get", "set", "load", "save", "parse",
  "render", "update", "create", "delete", "list", "config", "build", "close",
  "read", "write", "check", "format", "toString", "constructor", "__init__",
  // Framework conventions: repeated because the framework says so, not because
  // anyone duplicated a concern. Django migrations alone put "Migration" in 74
  // files of one real repo, burying every finding worth reading.
  "Migration", "setUp", "tearDown", "setUpClass", "Meta", "forwards", "backwards",
  "beforeEach", "afterEach", "describe", "ready", "apps", "urlpatterns"]);

// Generated or convention-bound trees. Repetition inside them says nothing
// about the design of the code someone actually wrote.
const BORING_PATHS = /(^|\/)(migrations|tests?|__tests__|spec|fixtures|vendor|third_party|generated)(\/|$)/i;

function cmdDuplicates(args) {
  // The objective half of an architecture review: the same name declared in
  // several files is a fact, not a judgement. Whether those files *should* be
  // unified is a judgement, and this deliberately does not make it -- that is
  // the part that needs a model, and it is the part a heuristic gets wrong.
  const project = resolveProject(process.cwd());
  const file = mapPath(project);
  let data = readJson(file, null);
  if (!data || args.includes("--refresh")) {
    ensureRoot();
    data = { root: process.cwd(), scannedAt: new Date().toISOString(), files: scanRepo(process.cwd()) };
    writeJson(file, data);
  }
  const files = data.files || [];
  if (!files.length) { console.log("No source files found. Run: map --refresh"); return; }

  const bySymbol = new Map();
  for (const f of files) {
    for (const s of f.symbols) {
      if (s.length < 5 || UBIQUITOUS.has(s)) continue;
      if (!bySymbol.has(s)) bySymbol.set(s, []);
      bySymbol.get(s).push(f.path);
    }
  }
  const repeated = [...bySymbol.entries()]
    .map(([s, paths]) => [s, [...new Set(paths)]])
    .filter(([, paths]) => paths.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  const byBase = new Map();
  for (const f of files) {
    const base = f.path.split("/").pop();
    if (/^(index|README|__init__)\./i.test(base)) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(f.path);
  }
  const sameName = [...byBase.entries()]
    .filter(([, paths]) => paths.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (!repeated.length && !sameName.length) {
    console.log("No repeated declarations or filenames found.");
    return;
  }
  if (repeated.length) {
    console.log(`Declarations defined in more than one file (${repeated.length}):\n`);
    for (const [sym, paths] of repeated.slice(0, 25)) {
      console.log(`  ${sym}  (${paths.length})`);
      for (const p of paths.slice(0, 6)) console.log(`      ${p}`);
    }
  }
  if (sameName.length) {
    console.log(`\nFilenames used in more than one directory (${sameName.length}):\n`);
    for (const [base, paths] of sameName.slice(0, 15)) {
      console.log(`  ${base}  (${paths.length})`);
      for (const p of paths.slice(0, 5)) console.log(`      ${p}`);
    }
  }
  console.log(`\nRepetition is not automatically a problem -- an interface implemented`);
  console.log(`several times looks identical to a concern copy-pasted. Read before merging.`);
}

// ---------------------------------------------------------------- decisions

// Decisions live in the transcript like everything else, which means one made
// in turn 47 of a long session is effectively lost: findable only by someone
// who already remembers enough to search for it. Recording it costs one line
// and makes it retrievable by subject forever.
//
// Stored as plain Markdown in the repo, not in the index: a decision is
// something the team should see in a diff and argue with, not a private note
// on one machine. The index picks it up like any other file the user writes.
function decisionsFile() {
  return path.join(process.cwd(), "DECISIONS.md");
}

function cmdDecide(args) {
  const file = decisionsFile();
  if (args.includes("--list") || !args.filter((a) => !a.startsWith("--")).length) {
    let body;
    try { body = fs.readFileSync(file, "utf8"); } catch {
      console.log(`No decisions recorded yet in ${file}.`);
      console.log(`Record one:  decide "chose X over Y because Z"`);
      return;
    }
    const needle = args.filter((a) => !a.startsWith("--")).join(" ").toLowerCase();
    const entries = body.split(/^## /m).slice(1);
    const hits = needle ? entries.filter((e) => e.toLowerCase().includes(needle)) : entries;
    if (!hits.length) { console.log(`No decision matching "${needle}".`); return; }
    for (const e of hits.slice(-20)) console.log("## " + e.trimEnd() + "\n");
    return;
  }

  const text = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  const date = new Date().toISOString().slice(0, 10);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], process.cwd());
  const header = fs.existsSync(file) ? "" :
    "# Decisions\n\nAppend-only. Each entry is what was decided, in the words used at the time.\n" +
    "Superseding a decision means adding a new entry that says so -- not editing the old one,\n" +
    "which would erase the reason anyone chose differently.\n";
  const entry = `\n## ${date}${branch ? ` (${branch})` : ""}\n\n${text}\n`;
  try {
    fs.appendFileSync(file, header + entry);
  } catch (e) {
    console.log(`Could not write ${file}: ${e.message}`);
    return;
  }
  console.log(`Recorded in ${file}:\n${entry.trim()}`);
}

// ------------------------------------------------------------------ standup

function git(args, cwd) {
  // Synchronous and dependency-free: spawnSync is in every Node, and shelling
  // out to git beats reimplementing ref parsing. The import is static because
  // ESM has no require() -- a lazy require() here throws at call time, gets
  // swallowed by the catch below, and reports "not a git repository" for a
  // repository that is perfectly fine.
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function cmdStandup(args) {
  const cwd = process.cwd();
  if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") {
    console.log("Not a git repository.");
    return;
  }
  const days = Number((args.find((a) => /^--days=\d+$/.test(a)) || "--days=14").split("=")[1]);
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) || "?";
  const base = ["main", "master", "develop"].find(
    (b) => git(["rev-parse", "--verify", "--quiet", b], cwd)) || null;

  console.log(`${cwd}\non ${current}${base ? `, comparing against ${base}` : ""}\n`);

  const dirty = git(["status", "--porcelain"], cwd);
  if (dirty) {
    const lines = dirty.split("\n").filter(Boolean);
    console.log(`## Uncommitted (${lines.length} file(s))`);
    for (const l of lines.slice(0, 12)) console.log(`  ${l}`);
    if (lines.length > 12) console.log(`  ... ${lines.length - 12} more`);
    console.log("");
  }

  const raw = git(["for-each-ref", "--sort=-committerdate", "refs/heads/",
    "--format=%(refname:short)\t%(committerdate:relative)\t%(committerdate:unix)\t%(subject)"], cwd);
  const branches = (raw || "").split("\n").filter(Boolean).map((l) => l.split("\t"));
  const cutoff = Date.now() / 1000 - days * 86400;
  const recent = branches.filter(([, , unix]) => Number(unix) >= cutoff);

  console.log(`## Branches active in the last ${days} days (${recent.length} of ${branches.length})`);
  for (const [name, rel, , subject] of recent.slice(0, 15)) {
    let gap = "";
    if (base && name !== base) {
      const counts = git(["rev-list", "--left-right", "--count", `${base}...${name}`], cwd);
      if (counts) {
        const [behind, ahead] = counts.split(/\s+/);
        gap = `  [+${ahead} / -${behind}]`;
      }
    }
    console.log(`  ${name}${gap}`);
    console.log(`      ${rel} -- ${(subject || "").slice(0, 80)}`);
  }

  const wt = git(["worktree", "list"], cwd);
  if (wt && wt.split("\n").length > 1) {
    console.log(`\n## Worktrees`);
    for (const l of wt.split("\n")) console.log(`  ${l}`);
  }
  console.log(`\n(+ahead / -behind relative to ${base || "the default branch"}. Nothing here was inferred.)`);
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

  // ISO weeks decide how digests group; a wrong boundary silently files a
  // session under the wrong week and the digest quietly omits it.
  assert(isoWeek("2026-01-01T00:00:00Z") === "2026-W01", "ISO week of Jan 1 wrong: " + isoWeek("2026-01-01T00:00:00Z"));
  assert(isoWeek("2026-12-31T00:00:00Z") === "2026-W53", "ISO week of Dec 31 wrong: " + isoWeek("2026-12-31T00:00:00Z"));
  assert(isoWeek("no es fecha") === "unknown", "fecha invalida no manejada");

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
  if (cmd === "timeline") return cmdTimeline(args);
  if (cmd === "digest") return cmdDigest(args);
  if (cmd === "topics") return cmdTopics(args);
  if (cmd === "map") return cmdMap(args);
  if (cmd === "duplicates") return cmdDuplicates(args);
  if (cmd === "standup") return cmdStandup(args);
  if (cmd === "decide") return cmdDecide(args);
  if (cmd === "rules") return cmdRules();
  if (cmd === "stats") return cmdStats();
  console.log("usage: recall.mjs [index|inject|search|show|sessions|timeline|digest|topics|map|duplicates|standup|decide|rules|stats|--selftest]");
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
