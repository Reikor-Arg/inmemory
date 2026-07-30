#!/usr/bin/env node
// Recall: BM25 over Claude Code transcripts, injected under a hard budget.
//
// Runs on any Node >= 18: no dependencies, and deliberately NOT node:sqlite,
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
import http from "node:http";
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

// FNV-1a: enough to spot an exact duplicate, and it keeps the stored set small.
// A collision would drop one chunk, not corrupt anything.
function hashText(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36) + ":" + t.length;
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
async function readNewChunks(file, startOffset, final = false) {
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
  // A finished session's last turn would otherwise never be indexed: it is
  // withheld each pass in case it is still growing, and once the session ends
  // nothing ever completes it. So the final thing done in every session was
  // missing from the index -- caught by doctor reporting 797 transcripts behind
  // immediately after a full backfill.
  if (final) {
    flush();
    return { chunks: out, resume: pos };
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
  const seenText = new Set(meta.hashes || []);
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
        let size, mtime;
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; }
        catch { continue; }
        if (size < start) start = 0; // truncated or replaced: reindex
        if (size === start) continue;
        // Untouched for a while means the session is over, so its trailing turn
        // is complete and safe to index rather than withhold forever.
        const finished = Date.now() - mtime > 10 * 60 * 1000;
        const { chunks, resume } = await readNewChunks(full, start, finished);
        for (const c of chunks) {
          // Byte-identical text carries nothing the first copy did not, and it
          // competes with real content for the injection budget. On a real
          // history this was 30% of the index and 24 MB: mostly one other
          // memory plugin's observer boilerplate, repeated 381 times, plus
          // /compact markers. Hash only -- the text itself is never stored twice.
          const h = hashText(c.text);
          if (seenText.has(h)) continue;
          seenText.add(h);
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
    meta.hashes = [...seenText];
    meta.hashes = [...seenText];
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

  // Every candidate that passes the gate, not just the first `limit`: the ones
  // past the cut are what withLaterTurns searches for a change of mind.
  const qualifying = [];
  const fd = openChunks();
  try {
    for (const [id, score] of ranked) {
      const rec = readChunkAt(fd, lens[id]);
      if (!rec) continue;
      if (project && rec.project !== project) continue;
      if (excludeSession && rec.session === excludeSession) continue;
      if (covered(rec.text, terms) < need) continue;
      qualifying.push({ ...rec, score: -score });
    }
  } finally {
    if (fd) fs.closeSync(fd);
  }
  return withLaterTurns(qualifying, limit);
}

// A transcript is full of things that were true for twenty minutes, and the
// ranking has no recency term: a turn that was later retracted scores exactly as
// well as the one that replaced it. Worse, BM25 rewards rare words, and the
// wording of an abandoned approach is usually rarer than the wording that
// survived -- so the retracted turn can outrank its own replacement.
//
// Weighting recency was the obvious fix and is the wrong one: it needs a
// constant nobody can guess, and too much of it breaks finding something from
// three weeks ago, which is half the value here.
//
// Instead, look where a change of mind actually lives: the same session, further
// on. For each hit, hand back the latest other chunk from that session which
// also matches the query, marked as the newer one. No constant to tune, no
// reordering -- it adds context rather than second-guessing the score.
//
// It cannot catch a retraction made in a different session, or one phrased
// without any of the query's words. It turns "the ranking has no idea" into "the
// ranking looks", which is not the same as solving it.
export function withLaterTurns(qualifying, limit) {
  const primary = qualifying.slice(0, limit);
  const chosen = new Set(primary.map((h) => h.id));
  const out = [];
  for (const h of primary) {
    out.push(h);
    let later = null;
    for (const c of qualifying) {
      if (c.session !== h.session || chosen.has(c.id)) continue;
      if (String(c.ts || "") <= String(h.ts || "")) continue;
      if (!later || String(c.ts) > String(later.ts)) later = c;
    }
    if (later) {
      chosen.add(later.id);
      out.push({ ...later, newer: true });
    }
  }
  return out;
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
    // Date *and* time, because the ranking has no recency term: two turns that
    // contradict each other are ordered by score, not by which one came later,
    // and a retracted decision often carries the rarer wording that BM25
    // rewards. The timestamp is the only thing telling the reader which of two
    // hits superseded the other, and a date alone cannot separate two turns
    // twenty minutes apart. Six characters is a cheap price for that.
    const when = (h.ts || "").slice(0, 16).replace("T", " ");
    const tag = h.newer ? " | NEWER, same session" : "";
    const line = `  #${h.id} | ${when} | session ${h.session.slice(0, 8)}${tag} | ${head}`;
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
  console.log("<recall> Turns from earlier sessions in this project whose wording " +
    "matches this message. Headers only, and a hit is what was said then, not what " +
    "is true now -- a turn marked NEWER came later in the same session and may " +
    `supersede the one above it. For the verbatim text: node "${SELF}" show <id> [<id>...]`);
  console.log(lines.join("\n"));
  console.log("</recall>");
}

// ------------------------------------------------------- automatic context

// Fired at SessionStart. Orientation, not a report: where this project left
// off, in a couple of hundred tokens. The alternative is the model opening
// cold and spending far more than that rediscovering the same thing with Glob
// and Grep -- or worse, not rediscovering it and asking the user.
// Checks GitHub for a newer release, at most once a day, and returns one line
// if there is one. Costs no model tokens -- it is an HTTPS GET and a string
// compare.
//
// It reports; it does not install. Plugins installed through /plugin live in a
// cache Claude Code manages, so a self-update fights the platform's own
// mechanism and breaks in ways that are hard to trace back. Beyond that, code
// that runs on every turn should not rewrite itself while nobody is looking.
//
// Set INMEMORY_UPDATE_CHECK=0 to switch it off.
function updateNotice() {
  if (process.env.INMEMORY_UPDATE_CHECK === "0") return Promise.resolve(null);
  const stamp = path.join(ROOT, ".update-check");
  const now = Date.now();
  try {
    const last = Number(fs.readFileSync(stamp, "utf8"));
    if (now - last < 24 * 3600 * 1000) return Promise.resolve(null);
  } catch { /* never checked */ }

  let local = null;
  try {
    local = JSON.parse(fs.readFileSync(
      path.join(HERE, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch { return Promise.resolve(null); }
  if (!local) return Promise.resolve(null);

  return new Promise((resolve) => {
    // Stamped before the request, not after: a network that hangs must not turn
    // into a check on every single session.
    try { ensureRoot(); fs.writeFileSync(stamp, String(now)); } catch { /* read-only */ }
    const url = "https://raw.githubusercontent.com/Reikor-Arg/inmemory/main/.claude-plugin/plugin.json";
    const done = (v) => resolve(v);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; done(v); } };
    setTimeout(() => finish(null), 3000).unref?.();
    import("node:https").then(({ get }) => {
      const req = get(url, { headers: { "User-Agent": "inmemory" } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const remote = JSON.parse(body).version;
            finish(remote && remote !== local
              ? `inmemory ${remote} is available (you have ${local}) -- update with: /plugin marketplace update inmemory`
              : null);
          } catch { finish(null); }
        });
      });
      req.on("error", () => finish(null));
      req.setTimeout(3000, () => { req.destroy(); finish(null); });
    }).catch(() => finish(null));
  });
}

// After a compaction the model has a summary of this session, not the session.
// What it needs back is the thread it was just following -- and that is still
// on disk, because compaction only rewrites context, never the transcript.
//
// The generic orientation is wrong here: previous sessions are not what was
// just lost. This reads the current session's own transcript and hands back the
// user's own words, in order.
// True when this session's transcript carries a compaction boundary written in
// the last few minutes. Independent of any payload field, so it keeps working
// if the hook contract is not what this code assumes.
function justCompacted(payload) {
  const sid = payload && payload.session_id;
  const cwd = (payload && payload.cwd) || process.cwd();
  if (!sid) return false;
  const file = path.join(PROJECTS_DIR, resolveProject(cwd), `${sid}.jsonl`);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  // Cheap pre-filter: the marker is rare, so most sessions never parse a line.
  if (!text.includes("compact_boundary")) return false;
  for (const line of text.split("\n").reverse()) {
    if (!line.includes("compact_boundary")) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "system" || d.subtype !== "compact_boundary") continue;
    const t = Date.parse(d.timestamp || "");
    return Number.isFinite(t) && Date.now() - t < 5 * 60 * 1000;
  }
  return false;
}

// The boundary line carrying preTokens is written at the same instant this hook
// fires -- 3 ms apart in the first real compaction measured, and it had not
// reached disk by the time the hook read the file, so the recap announced itself
// without a figure. Re-read a few times rather than report nothing. Bounded at
// 750 ms against a compaction that itself took 129 s, and it only ever waits
// when the figure is genuinely still missing.
async function compactRecap(payload) {
  const sid = payload && payload.session_id;
  const cwd = (payload && payload.cwd) || process.cwd();
  if (!sid) return null;
  const file = path.join(PROJECTS_DIR, resolveProject(cwd), `${sid}.jsonl`);

  let scan = scanRecap(file);
  for (let i = 0; scan && scan.asks.length && !scan.dropped && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 150));
    scan = scanRecap(file);
  }
  if (!scan || !scan.asks.length) return null;
  const { asks, files, cmds, dropped } = scan;

  const out = ["<compacted_session_recall>"];
  out.push(dropped
    ? `This session was compacted (${dropped.toLocaleString()} tokens of context replaced by a summary).`
    : "This session was compacted.");
  out.push("What the user actually asked for, in their own words, in order:");
  for (const a of asks.slice(-14)) out.push(`  ${a}`);
  if (files.length) {
    out.push(`Files touched: ${files.slice(-12).map((f) => path.basename(f)).join(", ")}`);
  }
  if (cmds.length) out.push(`Recent commands: ${cmds.slice(-4).join(" | ")}`);
  out.push(`Full verbatim text of any earlier turn: node "${SELF}" search <terms>`);
  out.push("</compacted_session_recall>");
  return out.join("\n");
}

function scanRecap(file) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return null; }

  const asks = [], files = [], cmds = [];
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    if (d.type === "system" && d.subtype === "compact_boundary") {
      dropped += (d.compactMetadata && d.compactMetadata.preTokens) || 0;
      continue;
    }
    if (d.type === "user" && !d.isMeta) {
      const t = userText((d.message || {}).content);
      // Only what the person actually typed: a real turn, not a one-word
      // acknowledgement and not a tool result.
      if (t && t.length > 15 && !t.startsWith("<")) asks.push(t.split("\n")[0].slice(0, 180));
    } else if (d.type === "assistant") {
      for (const b of ((d.message || {}).content) || []) {
        if (!b || b.type !== "tool_use") continue;
        const inp = b.input || {};
        if (inp.file_path && !files.includes(inp.file_path)) files.push(inp.file_path);
        else if (inp.command) {
          const c = String(inp.command).trim().split("\n")[0].slice(0, 60);
          if (c && !cmds.includes(c)) cmds.push(c);
        }
      }
    }
  }
  return { asks, files, cmds, dropped };
}

async function cmdSessionStart(payload) {
  const cwd = (payload && payload.cwd) || process.cwd();
  const project = resolveProject(cwd);

  // Before anything else, and on every kind of start including a compaction --
  // a routing rule that was dropped with the rest of the context stops being
  // followed, which is the whole reason it is cheap to resend.
  await emitRules();

  // Coming back from a compaction is a different situation from opening a
  // project: the thread that was just summarised away is what is missing, not
  // last week's work. Answer the actual gap.
  //
  // Two ways to notice. `source === "compact"` is the one that fires: confirmed
  // on a real compaction, where the boundary had not yet reached disk, so the
  // transcript check could not have been what triggered it. That check stays as
  // the fallback -- it does not care what the payload field is called, since a
  // compact_boundary written moments ago is a fact on disk rather than a guess
  // about an API that may be renamed.
  if ((payload && payload.source === "compact") || justCompacted(payload)) {
    // Everything read before the boundary has just left the context, so the
    // record saying "you already have this" is now false. Drop it.
    clearReads(payload && payload.session_id);
    const recap = await compactRecap(payload);
    if (recap) { console.log(recap); return; }
  }
  pruneReads();

  let update = null;
  try { update = await updateNotice(); } catch { /* never block the session */ }

  let sessions;
  try { sessions = scanSessions(project); } catch { sessions = []; }
  if (!sessions.length) {
    // Nothing to orient with, but a pending update is still worth one line.
    if (update) console.log(`<project_memory>\n${update}\n</project_memory>`);
    return;
  }

  const recent = sessions.slice(0, 3);
  const files = new Map();
  for (const s of recent) {
    for (const f of s.files) {
      const b = path.basename(f);
      files.set(b, (files.get(b) || 0) + 1);
    }
  }
  const top = [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f]) => f);

  const lines = ["<project_memory>"];
  lines.push(`Previous work in this project (${sessions.length} session(s) indexed):`);
  for (const s of recent) {
    lines.push(`  ${(s.ts || "").slice(0, 10)} | ${s.turns} turns | ${s.ask.slice(0, 120)}`);
  }
  if (top.length) lines.push(`Files touched recently: ${top.join(", ")}`);

  let decisions = null;
  try {
    const body = fs.readFileSync(path.join(cwd, "DECISIONS.md"), "utf8");
    const entries = body.split(/^## /m).slice(1);
    if (entries.length) {
      decisions = entries.slice(-2).map((e) => e.trim().split("\n").filter(Boolean).slice(0, 2).join(" -- "));
    }
  } catch { /* no decisions file */ }
  if (decisions) {
    lines.push("Latest recorded decisions:");
    for (const d of decisions) lines.push(`  ${d.slice(0, 160)}`);
  }
  if (update) lines.push(update);
  lines.push("</project_memory>");
  console.log(lines.join("\n"));
}

// ------------------------------------------------------------- re-reads
//
// A file read twice with nothing changed in between is paid for twice: the
// first copy is still sitting in the context window, word for word. This is the
// one saving here that needs no history at all -- it works in the first hour of
// a fresh install, with an empty index.
//
// Only whole-file reads are tracked. A read with offset/limit put *part* of the
// file in context, and there is no honest way to tell whether the part wanted
// now is the part that arrived then, so those are never blocked.
//
// The record is cleared at a compaction, because that is exactly the moment the
// premise stops holding: the file was in context, and now it is not.

const READS_DIR = path.join(ROOT, "reads");
const BLOCK_REREADS = process.env.INMEMORY_BLOCK_REREADS !== "0";

const readsFile = (session) =>
  path.join(READS_DIR, `${String(session).replace(/[^A-Za-z0-9_-]/g, "")}.json`);

function saveReads(session, map) {
  try {
    fs.mkdirSync(READS_DIR, { recursive: true });
    fs.writeFileSync(readsFile(session), JSON.stringify(map));
  } catch { /* read-only disk: tracking is an optimisation, never a requirement */ }
}

export function clearReads(session) {
  try { fs.unlinkSync(readsFile(session)); } catch { /* nothing to clear */ }
}

// Sessions end without telling anyone, so their records are swept on the next
// session start rather than tracked.
function pruneReads() {
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  let names;
  try { names = fs.readdirSync(READS_DIR); } catch { return; }
  for (const n of names) {
    const f = path.join(READS_DIR, n);
    try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch { /* gone already */ }
  }
}

export function rereadVerdict(payload) {
  const input = payload.tool_input || {};
  const target = input.file_path || input.notebook_path;
  const session = payload.session_id;
  if (!target || !session) return null;

  const key = path.resolve(String(target));
  const reads = readJson(readsFile(session), {});

  if (payload.tool_name !== "Read") {
    // An edit invalidates the copy in context: the next read is earned.
    if (reads[key]) { delete reads[key]; saveReads(session, reads); }
    return null;
  }
  if (input.offset !== undefined || input.limit !== undefined) return null;

  let st;
  try { st = fs.statSync(key); } catch { return null; }
  // A directory read returns a listing, not a file, and is cheap either way.
  if (!st.isFile()) return null;

  const prev = reads[key];
  if (prev && prev[0] === st.mtimeMs && prev[1] === st.size) return { key, when: prev[2] };

  reads[key] = [st.mtimeMs, st.size, new Date().toISOString().slice(11, 16)];
  saveReads(session, reads);
  return null;
}

function denyReread(v) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `${v.key} was already read in full at ${v.when} in this session, and has not ` +
        `changed since -- same size, same modification time. Its contents are already ` +
        `in the context above, word for word. Use that copy rather than paying for a ` +
        `second one.\n\n` +
        `Reading it again is allowed as soon as something changes it. To see one part ` +
        `of a large file, read it with offset/limit -- partial reads are never blocked.`,
    },
  }));
}

// Fired before a file is read or edited. If that file has been discussed
// before, say so now -- this is the moment the context is worth having, and
// the only moment it can be delivered without the model knowing to ask.
function cmdFileContext(payload) {
  if (BLOCK_REREADS) {
    let verdict = null;
    try { verdict = rereadVerdict(payload || {}); } catch { /* fail open */ }
    if (verdict) return denyReread(verdict);
  }

  const input = (payload && payload.tool_input) || {};
  const target = input.file_path || input.notebook_path;
  if (!target) return;
  const base = path.basename(String(target));
  if (base.length < MIN_TERM_LEN) return;

  const cwd = (payload && payload.cwd) || process.cwd();
  const session = payload.session_id || "";
  let hits;
  try {
    // Not the normal search path: that one requires two terms so a vague
    // prompt cannot retrieve anything, and a filename is exactly one. A
    // filename is specific enough on its own -- the rarity check below is what
    // keeps a common name like index.js from matching half the project.
    const meta = readJson(META, { docs: 0 });
    if (!meta.docs) return;
    const postings = postingsFor([base]);
    const df = (postings.get(base) || []).length;
    if (!df || df > Math.max(20, Math.floor(meta.docs * COMMON_TERM_RATIO))) return;
    const lens = readJson(OFFSETS, []);
    const avgdl = (meta.totalLen || 1) / meta.docs || 1;
    const ranked = [...bm25([base], postings, meta.docs, avgdl, lens).entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 24);
    const project = resolveProject(cwd);
    const fd = openChunks();
    hits = [];
    try {
      for (const [id] of ranked) {
        const rec = readChunkAt(fd, lens[id]);
        if (!rec || rec.project !== project || rec.session === session) continue;
        hits.push(rec);
        if (hits.length >= 3) break;
      }
    } finally { if (fd) fs.closeSync(fd); }
  } catch { return; }
  if (!hits.length) return; // nothing said about this file: inject nothing

  const lines = hits.map((h) =>
    `  #${h.id} | ${(h.ts || "").slice(0, 10)} | ${firstLine(h.text).slice(0, 150)}`);
  const context =
    `Earlier turns in this project mention ${base}. Verbatim excerpts are one ` +
    `command away -- node "${SELF}" show <id> -- and may be out of date with the ` +
    `current file:\n${lines.join("\n")}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
  }));
}

function cmdShow(args) {
  const ids = args.filter((a) => /^#?\d+$/.test(a)).slice(0, 6);
  if (!ids.length) { console.log(`uso: node "${SELF}" show <id> [<id>...]`); return; }
  for (const raw of ids) {
    const rec = readChunk(Number(raw.replace("#", "")));
    if (!rec) { console.log(`\n=== #${raw}: no existe ===`); continue; }
    console.log(`\n=== #${rec.id} | ${rec.project} | session ${rec.session.slice(0, 8)} | ${(rec.ts || "").slice(0, 16)} ===\n${rec.text}`);
  }
}

// ------------------------------------------------- adjudication (opt-in)
//
// withLaterTurns finds a retraction only when it lives in the same session and
// shares the query's words. A model reading both turns can tell regardless: it
// sees "no, scrap that" with no vocabulary in common at all.
//
// This is the only place a model is allowed to run, and it is deliberately not
// on the automatic path. Measured: `claude -p --model haiku` takes 6.9 s. Seven
// seconds of dead wait before every prompt you type is worse than the problem it
// solves. Seven seconds after you asked for a search is fine.
//
// Off unless INMEMORY_ADJUDICATE=1. Ollama first, because it is local and free.
// Fails open everywhere: no verdict just means the output looks like it always
// did.

// Yes/no, and not a choice between two labels. Measured on llama3.1:8b: asked to
// answer "SUPERSEDES or UNRELATED" it answered SUPERSEDES for everything,
// including turns with nothing to do with each other, and swapping the order of
// the two options changed nothing. A classifier that always says yes is worse
// than none, because it marks live decisions dead. Reframed as a yes/no question
// the same model scored 7/7, including four pairs on the same topic where the
// later turn did not reverse anything.
const ADJUDICATE_PROMPT =
  "Two turns from one work session, the second later than the first.\n" +
  "Did the second one change the decision made in the first?\n" +
  "Answer YES or NO and nothing else.\n\n";

function ollamaAsk(prompt, model, timeoutMs) {
  const raw = process.env.OLLAMA_HOST || "127.0.0.1:11434";
  const base = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  const body = JSON.stringify({
    model, prompt, stream: false, options: { num_predict: 8, temperature: 0 },
  });
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const url = new URL(`${base}/api/generate`);
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (data.length < 8000) data += c; });
        res.on("end", () => {
          try { done(JSON.parse(data).response || null); } catch { done(null); }
        });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); done(null); });
      req.on("error", () => done(null));
      req.end(body);
    } catch { done(null); }
  });
}

// Which model, decided once per run rather than per pair.
async function adjudicator() {
  if (process.env.INMEMORY_ADJUDICATE !== "1") return null;
  const model = await ollamaModel(1000);
  if (model) return { name: `ollama/${model}`, ask: (p) => ollamaAsk(p, model, 25000) };

  // There is no Haiku fallback, and the reason is not cost. `claude -p` is not an
  // API call: it is a whole Claude Code agent, carrying its own system prompt,
  // this project's CLAUDE.md and its MCP servers. Handed this exact prompt it
  // answered "What do you mean by Two? Need context" -- an agent given a vague
  // task, which is what it is. A direct API call needs a key most people running
  // Claude Code never set. So this needs Ollama and says so rather than
  // pretending.
  process.stderr.write(
    "adjudication is on but no Ollama answered on " +
    `${process.env.OLLAMA_HOST || "127.0.0.1:11434"} -- showing hits unjudged.\n`);
  return null;
}

// Bounded on purpose: each pair is a model round trip, and a
// search nobody can wait for is a search nobody runs.
export function supersededPairs(hits, max = 2) {
  const pairs = [];
  for (let i = 1; i < hits.length && pairs.length < max; i++) {
    if (hits[i].newer && hits[i - 1] && hits[i].session === hits[i - 1].session) {
      pairs.push([hits[i - 1], hits[i]]);
    }
  }
  return pairs;
}

const clip = (t, n = 400) => (t.length <= n ? t : t.slice(0, n) + "\n[...]");

async function cmdSearch(args) {
  const global = args.includes("--global");
  const query = args.filter((a) => a !== "--global").join(" ").trim();
  if (!query) { console.log("usage: recall.mjs search [--global] <query>"); return; }
  const hits = search(query, global ? null : resolveProject(process.cwd()), null, 10, 0.34);
  if (!hits.length) { console.log("No results."); return; }

  const verdicts = new Map();
  const judge = await adjudicator();
  if (judge) {
    const pairs = supersededPairs(hits);
    if (pairs.length) {
      process.stderr.write(`adjudicating ${pairs.length} pair(s) with ${judge.name}...\n`);
      for (const [older, newer] of pairs) {
        let out = null;
        try {
          out = await judge.ask(ADJUDICATE_PROMPT +
            `EARLIER (${(older.ts || "").slice(0, 16)}):\n${clip(older.text)}\n\n` +
            `LATER (${(newer.ts || "").slice(0, 16)}):\n${clip(newer.text)}\n`);
        } catch { /* fail open */ }
        if (out && /^\s*YES/i.test(out)) verdicts.set(older.id, newer.id);
      }
    }
  }

  for (const h of hits) {
    const tags = [];
    if (h.newer) tags.push("NEWER, same session");
    if (verdicts.has(h.id)) tags.push(`SUPERSEDED by #${verdicts.get(h.id)}`);
    const tag = tags.length ? ` | ${tags.join(" | ")}` : "";
    const body = h.text.length <= 1200 ? h.text : h.text.slice(0, 1200) + "\n[...]";
    console.log(`\n=== #${h.id} | session ${h.session.slice(0, 8)} | ${(h.ts || "").slice(0, 16)} | score ${h.score.toFixed(2)}${tag} ===\n${body}`);
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

export function rulesText(body) {
  if (body === undefined) {
    // Next to this file, or one level up: the plugin layout puts hooks/ under
    // the plugin root while ground_rules.md sits at the root, and a standalone
    // checkout keeps them side by side.
    for (const f of [path.join(HERE, "ground_rules.md"), path.join(HERE, "..", "ground_rules.md")]) {
      try { body = fs.readFileSync(f, "utf8"); break; } catch { /* try next */ }
    }
  }
  if (!body) return null;

  // Everything after the LAST line that is exactly `---`. This used to split on
  // the string "---" and take the last piece, which injected the file's own
  // documentation and its commented-out optional block: 549 tokens where the
  // file claimed 150, two thirds of it notes that should never reach a prompt.
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "---") { start = i + 1; break; }
  }
  const rules = (start >= 0 ? lines.slice(start).join("\n") : body)
    .replace(/<!--[\s\S]*?-->/g, "")   // commented out means off, not injected
    .trim();
  return rules || null;
}

// A local model does the cheap tier for free. Worth one line of the injection,
// but only when it is actually there -- an absent Ollama costs a refused
// connection on localhost and says nothing.
// Returns the name of a model Ollama has loaded, or null. Used both to add a
// line to the routing rules and to decide who adjudicates a contradiction.
export async function ollamaModel(timeoutMs = 300) {
  const raw = process.env.OLLAMA_HOST || "127.0.0.1:11434";
  const url = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.get(`${url}/api/tags`, (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null); }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (data.length < 20000) data += c; });
        res.on("end", () => {
          try {
            const models = JSON.parse(data).models || [];
            const want = process.env.INMEMORY_OLLAMA_MODEL;
            if (want) {
              done(models.some((m) => m.name === want) ? want : (models[0] || {}).name || null);
              return;
            }
            done((models[0] || {}).name || null);
          } catch { done(null); }
        });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); done(null); });
      req.on("error", () => done(null));
    } catch { done(null); }
  });
}

async function ollamaLine() {
  const name = await ollamaModel();
  return name
    ? `- Ollama is running here with ${name}. Use it for the transforms above instead of Haiku: same work, no tokens.`
    : null;
}

async function emitRules() {
  if (process.env.INMEMORY_RULES === "0") return;
  const rules = rulesText();
  if (!rules) return;
  let extra = null;
  try { extra = await ollamaLine(); } catch { /* never block a session start */ }
  console.log(`<ground_rules>\n${rules}${extra ? `\n${extra}` : ""}\n</ground_rules>`);
}

function cmdRules() {
  const rules = rulesText();
  if (rules) console.log(`<ground_rules>\n${rules}\n</ground_rules>`);
}

// Turns "it does not work" into a list of specific things that are or are not
// true. Every check says what to do about a failure -- a diagnostic that only
// reports a problem leaves the user exactly where they started.
// ------------------------------------------------------------------- lint

// Patterns written to overcome older models' reluctance. Current models follow
// the system prompt closely, so these now overtrigger -- the tool fires when it
// should not, the caveat appears when nobody asked. Anthropic's own migration
// notes give the replacements: "CRITICAL: You MUST use this tool when..."
// becomes "Use this tool when...", and "If in doubt, use X" is simply deleted.
const LINT_RULES = [
  [/\b(CRITICAL|MANDATORY|ABSOLUTELY|UNDER NO CIRCUMSTANCES)\b/g,
   "Written to force compliance. Current models already comply; the emphasis makes them overtrigger."],
  [/\bYOU MUST\b|\bALWAYS MUST\b/g,
   "Drop to a plain instruction: 'Use X when...' rather than 'YOU MUST use X'."],
  [/\bif in doubt\b[^.\n]*/gi,
   "Delete. This existed to push past reluctance that current models no longer have."],
  [/\bdefault to (using|calling|invoking)\b[^.\n]*/gi,
   "Name the condition instead: 'Use X when <situation>'."],
  [/\bNEVER\b(?![^\n]{0,40}(secret|password|key|token|credential))/g,
   "A blanket NEVER outside a safety rule usually overshoots. State the case it actually covers."],
  // Three or more capitalised words in a row: an actual shouted sentence.
  // Matching single words flagged CLAUDE, CONTEXT and ROUTING -- headings and
  // product names, not emphasis. A rule that mostly fires on false positives
  // gets ignored along with the ones that were right.
  // Spaces only: hyphenated capitals are identifiers (DESIGN-IT-TWICE), not
  // emphasis.
  [/\b[A-Z]{4,}(?: [A-Z]{2,}){2,}\b/g,
   "A shouted phrase. Current models weigh a plain sentence the same and it costs fewer tokens."],
];

function lintFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const findings = [];
  for (const [re, advice] of LINT_RULES) {
    re.lastIndex = 0;
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const hit = m[0].trim().slice(0, 60);
      if (seen.has(hit.toLowerCase())) continue;
      seen.add(hit.toLowerCase());
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({ line, hit, advice });
      if (seen.size >= 4) break; // one example per pattern is enough to act on
    }
  }
  return { file, bytes: text.length, tokens: Math.round(text.length / CHARS_PER_TOKEN), findings };
}

function cmdLint() {
  const targets = [
    path.join(process.cwd(), "CLAUDE.md"),
    path.join(HOME, ".claude", "CLAUDE.md"),
    path.join(process.cwd(), ".claude", "CLAUDE.md"),
  ];
  try {
    const dir = path.join(HOME, ".claude", "skills");
    for (const d of fs.readdirSync(dir)) targets.push(path.join(dir, d, "SKILL.md"));
  } catch { /* no user skills */ }

  const reports = targets.map(lintFile).filter(Boolean);
  if (!reports.length) { console.log("No CLAUDE.md or skills found to check."); return; }

  // The distinction matters more than the numbers. A CLAUDE.md is in the prompt
  // on every turn forever; a skill's *body* is only loaded when it is invoked,
  // and only its description sits in the prefix. Reporting them together would
  // suggest a 20,000-token skill costs 20,000 tokens a turn. It costs about 90.
  const always = reports.filter((r) => /CLAUDE\.md$/i.test(r.file));
  const onDemand = reports.filter((r) => /SKILL\.md$/i.test(r.file));

  if (always.length) {
    console.log("Loaded on EVERY turn of every session:\n");
    for (const r of always.sort((a, b) => b.tokens - a.tokens)) {
      console.log(`  ~${String(r.tokens).padStart(5)} tok  ${r.file}`);
    }
    const t = always.reduce((n, r) => n + r.tokens, 0);
    console.log(`\n  ~${t} tokens per turn. This is the one that compounds.\n`);
  }

  if (onDemand.length) {
    const heavy = onDemand.sort((a, b) => b.tokens - a.tokens).slice(0, 8);
    console.log("Loaded only WHEN INVOKED (heaviest skills):\n");
    for (const r of heavy) {
      console.log(`  ~${String(r.tokens).padStart(5)} tok  ${path.basename(path.dirname(r.file))}`);
    }
    console.log(`\n  ${onDemand.length} skills. In the prefix each costs only its`);
    console.log("  description (~70-100 tok); the size above is paid on invocation.\n");
  }

  const withFindings = reports.filter((r) => r.findings.length);
  if (!withFindings.length) {
    console.log("No patterns found that current models no longer need.");
    return;
  }
  console.log("Phrasing written for older models -- these now overtrigger:\n");
  for (const r of withFindings) {
    console.log(`${r.file}`);
    for (const f of r.findings.slice(0, 6)) {
      console.log(`  line ${f.line}: "${f.hit}"`);
      console.log(`      ${f.advice}`);
    }
    console.log("");
  }
  console.log("Judgement required: a rule that genuinely is critical stays. This");
  console.log("flags phrasing, not intent -- read each one before changing it.");
}

async function cmdDoctor() {
  // Three levels, not two. A diagnostic that flags an expected state as a
  // failure teaches the reader to skim past all of it, including the line that
  // mattered.
  const ok = [], bad = [], info = [];
  const check = (cond, good, fix) => (cond ? ok : bad).push(cond ? good : fix);
  const note = (cond, good, msg) => (cond ? ok : info).push(cond ? good : msg);

  const major = Number((process.versions.node || "0").split(".")[0]);
  check(major >= 18, `Node ${process.versions.node}`,
        `Node ${process.versions.node} is too old -- needs 18 or newer.`);

  const meta = readJson(META, null);
  const docs = meta ? meta.docs || 0 : 0;
  check(docs > 0, `${docs} turns indexed`,
        "Index is empty. Run:  index --all   (about 25s for a large history)");

  let transcripts = 0;
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      try {
        transcripts += fs.readdirSync(path.join(PROJECTS_DIR, d))
          .filter((f) => f.endsWith(".jsonl")).length;
      } catch { /* unreadable project dir */ }
    }
  } catch { /* no projects dir */ }
  check(transcripts > 0, `${transcripts} transcripts found in ${PROJECTS_DIR}`,
        `No transcripts in ${PROJECTS_DIR}. Claude Code writes them itself -- ` +
        "if this is a fresh install there is simply nothing to index yet.");

  // "The index exists" is not "the index is current". This check was added
  // after doctor reported everything OK while sitting four hours behind: the
  // Stop hook had not been running, and nothing said so. Comparing the stored
  // read offset against the file size is the only way to see it.
  let behind = 0;
  try {
    const files = (meta && meta.files) || {};
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const full = path.join(PROJECTS_DIR, dir);
      for (const f of fs.readdirSync(full).filter((x) => x.endsWith(".jsonl"))) {
        const p = path.join(full, f);
        const st = fs.statSync(p);
        // Only sessions that have finished. A live session always has an
        // unindexed trailing turn by design, and flagging that would mean the
        // check is red whenever anyone is working.
        if (Date.now() - st.mtimeMs < 10 * 60 * 1000) continue;
        if (st.size - (files[p] || 0) > 2000) behind++;
      }
    }
  } catch (e) { behind = -1; process.stderr.write(`staleness check skipped: ${e.message}\n`); }
  if (behind >= 0) {
    check(behind === 0, "Index is up to date with every transcript",
          `${behind} transcript(s) have content not yet indexed. Run:  index --all`);
  }

  // On macOS and Linux every hook is launched through run.sh, so a missing or
  // unreadable one means the whole plugin is inert -- and inert here looks
  // exactly like working and having nothing to say.
  const launcher = path.join(HERE, "run.sh");
  if (process.platform === "win32") {
    note(true, "Windows: hooks call node directly (run.sh is for macOS and Linux)");
  } else {
    check(fs.existsSync(launcher), "Hook launcher present (hooks/run.sh)",
          `hooks/run.sh is missing. Every hook is launched through it on this ` +
          `platform, so nothing will run. Reinstall the plugin.`);
    let firstLine = "";
    try { firstLine = fs.readFileSync(launcher, "utf8").split("\n")[0]; } catch { /* reported above */ }
    check(!firstLine.includes("\r"),
          "Launcher has Unix line endings",
          "hooks/run.sh has Windows line endings and cannot start on this platform " +
          "(/bin/sh^M). Re-clone with .gitattributes honoured, or run: " +
          `sed -i 's/\\r$//' ${launcher}`);
  }

  const rules = process.env.INMEMORY_RULES === "0" ? null : rulesText();
  note(!!rules,
       `Routing rules injected each session (~${Math.round((rules || "").length / CHARS_PER_TOKEN)} tokens)`,
       "Routing rules are off (INMEMORY_RULES=0 or ground_rules.md missing) -- " +
       "nothing tells the session to push cheap work to a cheaper model.");

  const ollama = await ollamaLine();
  note(!!ollama,
       `Ollama detected -- text transforms can run locally for free`,
       `No Ollama on ${process.env.OLLAMA_HOST || "127.0.0.1:11434"} -- not a problem, ` +
       "the rules fall back to Haiku. Only worth starting if you already use it.");

  note(process.env.INMEMORY_BLOCK_REREADS !== "0",
       "Re-reading an unchanged file is declined",
       "Re-read blocking is off (INMEMORY_BLOCK_REREADS=0) -- the same file can be " +
       "paid for twice in one session.");

  const project = resolveProject(process.cwd());
  const here = fs.existsSync(path.join(PROJECTS_DIR, project));
  note(here, `This directory maps to project "${project}"`,
       `No transcripts yet for this directory (expected "${project}") -- expected ` +
       "in a project you have not used Claude Code in. It fills as you work.");

  try {
    ensureRoot();
    const probe = path.join(ROOT, ".probe");
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    ok.push(`Index directory is writable (${ROOT})`);
  } catch (e) {
    bad.push(`Cannot write to ${ROOT}: ${e.message}. Indexing will silently do nothing.`);
  }

  const git = fs.existsSync(path.join(process.cwd(), ".git"));
  note(git, "Inside a git repository (standup available)",
       "Not a git repository -- everything works except standup.");

  if (docs > 0) {
    const t0 = Date.now();
    let hits = 0;
    try { hits = search("index recall memory", null, null, 4).length; } catch { /* reported below */ }
    ok.push(`Search runs in ${Date.now() - t0} ms (${hits} hit(s) on a sample query)`);
  }

  console.log("inmemory doctor\n");
  for (const line of ok) console.log(`  OK    ${line}`);
  for (const line of info) console.log(`  NOTE  ${line}`);
  for (const line of bad) console.log(`  FIX   ${line}`);
  console.log(bad.length
    ? `\n${bad.length} thing(s) to fix above.`
    : "\nNothing to fix. If context still is not arriving, the hooks may not be " +
      "loaded: restart Claude Code, and check /plugin shows inmemory as enabled.");
}

function cmdStats() {
  const meta = readJson(META, { docs: 0, files: {} });
  let bytes = 0;
  try { bytes = fs.statSync(CHUNKS).size; } catch { /* no index yet */ }
  console.log(`chunks=${meta.docs}  files=${Object.keys(meta.files).length}  data=${bytes} B  (${ROOT})`);
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
        { type: "tool_result", content: [{ type: "text", text: "option B" }] }] } }),
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
  assert(chunks.length === 1, `an unfinished turn must not be indexed: ${chunks.length}`);
  const body = chunks[0].text;
  assert(body.includes("arreglar el deploy") && body.includes("kubectl rollout status"),
    "lost the request or the command");
  assert(!body.includes("DUPLICADO POR STREAMING"), "no deduplico el streaming");
  assert(body.includes("option B"), "lost an AskUserQuestion answer");
  assert(!body.includes("ZZZ"), "indexo un Volcado");
  assert(!body.includes("YYY"), "indexo un cuerpo de skill (isMeta)");
  assert(body.length < MAX_CHUNK_CHARS + 200, `chunk sin acotar: ${body.length}`);

  const again = await readNewChunks(file, resume);
  assert(again.chunks.length === 0, "reindexo lo ya emitido");

  // A finished session has to hand over its last turn or it is lost for good:
  // every pass holds it back in case the turn is still growing, and once the
  // session ends nothing ever completes it. The final turn of EVERY session was
  // missing -- 4,076 chunks out of 14,268 in a real history.
  const done = await readNewChunks(file, 0, true);
  assert(done.chunks.length === 2,
    `a finished session must emit 2 turns, emitted ${done.chunks.length}`);
  assert(done.chunks[1].text.includes("segundo pedido"), "lost the final turn");

  assert(splitTurn("u", ["a".repeat(5000), "b".repeat(5000)]).length === 2,
    "did not split the long turn");
  assert(covered("el timeout de socket", ["timeout", "socket"]) === 2, "coverage miscounted");
  assert(covered("colored mantengo", ["color", "tengo"]) === 0, "counted substrings");
  assert(JSON.stringify(termsOf("el timeout de socket")) === JSON.stringify(["timeout", "socket"]),
    "termsOf did not filter stopwords");

  const ptrs = renderPointers(
    Array.from({ length: 40 }, (_, i) => ({ id: i, text: `titulo ${i}\n` + "x".repeat(9000),
      session: "sess", ts: "2026-01-01" })), 100);
  assert(ptrs.length > 0, "produced no pointers");
  assert(ptrs.join("").length <= Math.floor(100 * CHARS_PER_TOKEN), "budget not respected");
  assert(!ptrs.some((p) => p.includes("x".repeat(50))), "the pointer dragged the body along");

  // ISO weeks decide how digests group; a wrong boundary silently files a
  // session under the wrong week and the digest quietly omits it.
  assert(isoWeek("2026-01-01T00:00:00Z") === "2026-W01", "ISO week of Jan 1 wrong: " + isoWeek("2026-01-01T00:00:00Z"));
  assert(isoWeek("2026-12-31T00:00:00Z") === "2026-W53", "ISO week of Dec 31 wrong: " + isoWeek("2026-12-31T00:00:00Z"));
  assert(isoWeek("no es fecha") === "unknown", "invalid date not handled");

  // Re-read blocking denies a tool call, so every branch that decides "you
  // already have this" is checked. A false positive here hides a file the model
  // genuinely needs, which is worse than the tokens it saves.
  const sess = "selftest-rereads";
  const probe = path.join(os.tmpdir(), `inmemory-selftest-${process.pid}.txt`);
  fs.writeFileSync(probe, "uno");
  clearReads(sess);
  const read = (extra = {}) =>
    rereadVerdict({ tool_name: "Read", session_id: sess, tool_input: { file_path: probe, ...extra } });

  assert(read() === null, "a first read can never be blocked");
  assert(read() !== null, "an identical second read must be blocked");
  assert(read({ offset: 10 }) === null, "a partial read is never blocked");

  fs.writeFileSync(probe, "uno y algo mas");   // distinto tamano -> distinto contenido
  assert(read() === null, "the file changed: the re-read is earned");
  assert(read() !== null, "must block again once the change is recorded");

  rereadVerdict({ tool_name: "Edit", session_id: sess, tool_input: { file_path: probe } });
  assert(read() === null, "after an edit, the re-read is earned");

  read();
  clearReads(sess);
  assert(read() === null, "a compaction clears the record: the file left the context");

  assert(rereadVerdict({ tool_name: "Read", session_id: sess,
    tool_input: { file_path: path.join(os.tmpdir(), "no-existe-inmemory") } }) === null,
    "a missing file is not judged");

  clearReads(sess);
  try { fs.unlinkSync(probe); } catch { /* already gone */ }

  // A retracted turn scores exactly as well as the one that replaced it, so the
  // later turn from the same session is the only signal of which one won. A bug
  // here hands back a dead decision wearing the face of a live one.
  const q = [
    { id: 1, session: "a", ts: "2026-01-01T10:00" },   // the abandoned one, better score
    { id: 2, session: "a", ts: "2026-01-01T10:20" },   // the retraction
    { id: 3, session: "b", ts: "2026-01-02T09:00" },
    { id: 4, session: "a", ts: "2026-01-01T09:00" },   // earlier: no use
  ];
  const w = withLaterTurns(q, 1);
  assert(w.length === 2, `expected the hit and its later turn, got ${w.length}`);
  assert(w[0].id === 1 && w[1].id === 2, `wrong order: ${w.map((x) => x.id).join(",")}`);
  assert(w[1].newer === true, "the later turn was not marked");
  assert(!w[0].newer, "the primary must not be marked");

  // The newest in the session, not the first one encountered.
  const w2 = withLaterTurns([
    { id: 1, session: "a", ts: "2026-01-01T10:00" },
    { id: 2, session: "a", ts: "2026-01-01T10:20" },
    { id: 3, session: "a", ts: "2026-01-01T11:00" },
  ], 1);
  assert(w2.length === 2 && w2[1].id === 3, `must return the latest: ${JSON.stringify(w2.map((x) => x.id))}`);

  // Nothing later in the same session -> one pointer, nothing invented.
  const w3 = withLaterTurns([{ id: 1, session: "a", ts: "2026-01-01T10:00" }], 1);
  assert(w3.length === 1 && !w3[0].newer, "invented a later turn where there was none");

  // No chunk is returned twice, even when it is the later turn for two primaries.
  const w4 = withLaterTurns(q, 4);
  const ids = w4.map((x) => x.id);
  assert(new Set(ids).size === ids.length, `duplicated pointers: ${ids.join(",")}`);

  // Only a pair the ranking itself flagged gets sent to a model. Widen this and
  // an explicit search turns into a dozen round trips nobody asked for.
  const A = { id: 1, session: "a", ts: "10:00" };
  const B = { id: 2, session: "a", ts: "10:20", newer: true };
  const C = { id: 3, session: "b", ts: "11:00" };
  assert(supersededPairs([A, B]).length === 1, "did not pair a hit with its later turn");
  assert(supersededPairs([A, C]).length === 0, "paired a turn that was never flagged newer");
  assert(supersededPairs([A, { ...B, session: "z" }]).length === 0, "paired across sessions");
  assert(supersededPairs([A, B, A, B], 1).length === 1, "ignored the pair cap");
  assert(supersededPairs([B]).length === 0, "paired a newer turn with nothing before it");

  // The rules ship on every session: anything that slips in here is paid for always.
  const doc = [
    "# Title", "prose explaining the file", "",
    "<!--", "- an option that is off", "-->", "",
    "---", "", "- **A real rule.** This reaches the prompt.",
  ].join("\n");
  const r = rulesText(doc);
  assert(r === "- **A real rule.** This reaches the prompt.", `rule trimmed wrong: ${JSON.stringify(r)}`);
  assert(!r.includes("prose"), "injected the file's own documentation");
  assert(!r.includes("an option that is off"), "injected a commented-out block");
  assert(rulesText("sin separador") === "sin separador", "with no marker the whole file goes");
  assert(rulesText("") === null, "an empty file injects nothing");

  const real = rulesText();
  assert(real && real.length < 1200,
    `the repo rules weigh ${real ? real.length : 0} chars, too much for every session`);

  // Both versions are hand-edited and drifted apart for three releases with
  // nothing warning. `claude plugin validate` catches it; the selftest runs on
  // every change, and validate only when someone remembers.
  const vp = path.join(HERE, "..", ".claude-plugin", "plugin.json");
  const vm = path.join(HERE, "..", ".claude-plugin", "marketplace.json");
  if (fs.existsSync(vp) && fs.existsSync(vm)) {
    const a = readJson(vp, {}).version;
    const b = ((readJson(vm, {}).plugins || [])[0] || {}).version;
    assert(a && a === b, `plugin.json says ${a}, marketplace.json says ${b}`);
  }

  console.log("OK: selftest passed");
}

function assert(cond, msg) { if (!cond) { throw new Error(msg); } }

// ------------------------------------------------------------------ dispatch

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "--selftest") return selftest();
  if (cmd === "index") return console.log(`new chunks: ${await cmdIndex(process.cwd(), args.includes("--all"))}`);
  if (cmd === "hook-index") {
    const payload = await readStdin();
    return void (await cmdIndex(payload.cwd || process.cwd(), false));
  }
  if (cmd === "inject") return cmdInject(await readStdin());
  if (cmd === "session-start") return cmdSessionStart(await readStdin());
  if (cmd === "file-context") return cmdFileContext(await readStdin());
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
  if (cmd === "lint") return cmdLint();
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "stats") return cmdStats();
  console.log("usage: recall.mjs [index|inject|search|show|sessions|timeline|digest|topics|map|duplicates|standup|decide|doctor|lint|rules|stats|--selftest]");
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
