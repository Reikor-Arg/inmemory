#!/usr/bin/env node
// PreToolUse hook: stop heavy Skill loads from detonating the prompt.
//
// Invoking a Skill inlines its markdown into the prompt and keeps it there for
// the rest of the session. Most skills are a few KB. A few are enormous: one
// measured 794 KB on disk and showed up as a single 324,834-token cache write,
// raising the per-turn floor from 59k to 400k -- about 75% of that session's
// cost, for two facts that a single file would have answered.
//
// This is not a denylist. It weighs the skill and, above a threshold, declines
// with instructions to read the one file actually needed. Skills are already
// built for that: SKILL.md is an index. Nothing becomes unreachable.
//
// Fails open everywhere: unknown skill, unreadable directory, malformed
// payload, bad env var -- all allow the call through. A hook that cannot
// measure must not block.
//
// Env: SKILL_WEIGHT_LIMIT (bytes, default 120000), SKILL_WEIGHT_ALLOW (csv)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_LIMIT = 120000;
const CHARS_PER_TOKEN = 3.3;

const limit = () => {
  const n = Number(process.env.SKILL_WEIGHT_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
};

const allowed = () =>
  new Set((process.env.SKILL_WEIGHT_ALLOW || "").split(",")
    .map((s) => s.trim().toLowerCase()).filter(Boolean));

function skillRoots() {
  const home = os.homedir();
  const tmp = os.tmpdir();
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".claude", "plugins", "cache"),
    path.join(tmp, "claude", "bundled-skills"),
  ];
}

// Depth-limited walk: the bundled-skills tree is versioned and deep, and an
// unbounded scan of it costs more than the hook is allowed to spend.
function findDirs(root, name, depth = 6) {
  const found = [];
  const walk = (dir, left) => {
    if (left < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === name) found.push(full);
      walk(full, left - 1);
    }
  };
  walk(root, depth);
  return found;
}

function findSkillDir(rawName) {
  // "plugin:skill" -> the directory is named for the skill, not the plugin.
  const leaf = String(rawName).split(":").pop().trim();
  if (!leaf || leaf.includes("/") || leaf.includes("\\") || leaf.startsWith(".")) return null;

  const marked = [], bare = [];
  for (const root of skillRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const dir of findDirs(root, leaf)) {
      if (fs.existsSync(path.join(dir, "SKILL.md"))) marked.push(dir);
      bare.push(dir);
    }
  }
  // Shallowest first: a skill can contain sub-directories sharing its own name
  // (claude-api ships python/claude-api, typescript/claude-api), and measuring
  // one of those sees a fraction of the real weight. Within a depth, the
  // highest-sorting path wins -- bundle dirs are version-named, so that is the
  // newest installed copy.
  const rank = (paths) => [...new Set(paths)]
    .sort((a, b) => b.localeCompare(a))
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);

  // A directory holding SKILL.md is the skill itself. Prefer those absolutely:
  // a plugin's own directory can share the skill's name and is far larger,
  // which would weigh the whole plugin instead of the one skill.
  if (marked.length) return rank(marked)[0];

  // No SKILL.md anywhere: bundled skills ship only reference docs on disk and
  // the harness supplies SKILL.md from the binary. Requiring it would miss
  // exactly the heaviest skills.
  for (const dir of rank(bare)) {
    if (hasMarkdown(dir)) return dir;
  }
  return null;
}

function hasMarkdown(dir, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".md")) return true;
    if (e.isDirectory() && depth > 0 && hasMarkdown(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

function weigh(dir) {
  let total = 0;
  const files = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.name.toLowerCase().endsWith(".md")) {
        try {
          const size = fs.statSync(full).size;
          total += size;
          files.push([size, r]);
        } catch { /* unreadable file: not counted */ }
      }
    }
  };
  walk(dir, "");
  files.sort((a, b) => b[0] - a[0]);
  return { total, biggest: files.slice(0, 6) };
}

function deny(name, dir, total, biggest) {
  const tokens = Math.round(total / CHARS_PER_TOKEN);
  const index = path.join(dir, "SKILL.md");
  const entry = fs.existsSync(index)
    ? `Start with ${index}, then Read only the file it points you to.`
    : `Read only the specific file you need from ${dir}.`;
  const listing = biggest.map(([s, p]) => `  ${String(s).padStart(9)} B  ${p}`).join("\n");
  const reason =
    `Skill '${name}' is ${total} bytes (~${tokens} tokens) and was not loaded -- invoking it ` +
    `would inline all of that into the prompt and keep it there for the rest of the session.\n\n` +
    `${entry}\nLargest files in this skill:\n${listing}\n\n` +
    `If you genuinely need the whole skill loaded, say so and the user can raise ` +
    `SKILL_WEIGHT_LIMIT or add '${name}' to SKILL_WEIGHT_ALLOW.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
}

export function check(name) {
  if (!name || allowed().has(String(name).toLowerCase())) return null;
  const dir = findSkillDir(name);
  if (!dir) return null; // can't locate it -> can't judge it -> allow
  const { total, biggest } = weigh(dir);
  if (total <= limit()) return null;
  return { name, dir, total, biggest };
}

function selftest() {
  if (findSkillDir("../etc/passwd") !== null) throw new Error("path traversal not rejected");
  if (findSkillDir("") !== null) throw new Error("empty name not rejected");
  if (check("definitely-not-a-real-skill-xyz") !== null) throw new Error("unknown skill must fail open");
  console.log("OK: selftest passed");
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();

  const payload = await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    setTimeout(() => resolve({}), 5000).unref?.();
  });

  if (payload.tool_name !== "Skill") return;
  const input = payload.tool_input;
  if (!input || typeof input !== "object") return;
  const verdict = check(input.skill);
  if (verdict) deny(verdict.name, verdict.dir, verdict.total, verdict.biggest);
}

main().catch(() => process.exit(0)); // fail open
