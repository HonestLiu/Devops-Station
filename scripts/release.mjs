#!/usr/bin/env node
// One-click release: checks → bump version → commit → tag → push.
//
// Usage:
//   npm run release                    # auto bump patch (0.1.16 → 0.1.17)
//   npm run release -- 0.1.17          # explicit version
//   npm run release -- -m "fix: ..."   # custom commit message (used verbatim)
//   npm run release -- --skip-checks   # skip tsc + cargo check gates
//   npm run release -- --remote gitee  # push to another remote (default: github)
//   npm run release -- --no-push       # commit + tag locally only
//
// The version is bumped via `npm version --no-git-tag-version`, whose
// lifecycle script (package.json "version") runs scripts/sync-version.mjs to
// keep src-tauri/Cargo.toml and src-tauri/tauri.conf.json in sync.

import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const run = (cmd, cwd = root) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
};
const out = (cmd, cwd = root) =>
  execSync(cmd, { cwd, encoding: "utf8", shell: true }).trim();

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const current = pkg.version;

// --- parse args -------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const versionArg = args.find((a) => !a.startsWith("-"));
const message = flag("-m") ?? flag("--message");
const remote = flag("--remote") ?? "github";
const skipChecks = args.includes("--skip-checks");
const noPush = args.includes("--no-push");

if (message === undefined && (args.includes("--message") || args.includes("-m"))) {
  console.error("[release] missing value after -m/--message");
  process.exit(1);
}

// --- resolve target version ---------------------------------------------------
let target = versionArg;
if (!target) {
  const [maj, min, pat] = current.split(".").map(Number);
  target = `${maj}.${min}.${pat + 1}`;
  console.log(`[release] no version given -> auto bump patch: ${current} -> ${target}`);
} else if (/^patch$|^minor$|^major$/.test(target)) {
  console.error(`[release] keyword "${target}" is not supported; pass a full version like 0.1.17`);
  process.exit(1);
} else if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`[release] invalid version: ${target}`);
  process.exit(1);
}
if (target === current) {
  console.error(`[release] version ${target} equals the current version; nothing to release`);
  process.exit(1);
}

// --- sanity: the tag must not already exist ------------------------------------
try {
  out(`git rev-parse --verify --quiet refs/tags/v${target}`);
  console.error(`[release] tag v${target} already exists; pick a different version`);
  process.exit(1);
} catch {
  /* tag is free — good */
}

// --- pre-flight checks ---------------------------------------------------------
if (!skipChecks) {
  console.log("\n[release] pre-flight checks (use --skip-checks to bypass)…");
  run("npx tsc --noEmit");
  run("cargo check", join(root, "src-tauri"));
} else {
  console.log("\n[release] skipping checks (--skip-checks)…");
}

// --- bump version (sync-version.mjs runs via the "version" lifecycle script) ---
console.log("\n[release] bumping version…");
run(`npm version ${target} --no-git-tag-version`);
run("node scripts/sync-version.mjs"); // belt-and-suspenders, idempotent

const ver = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (ver !== target) {
  console.error(`[release] version mismatch after bump: expected ${target}, got ${ver}`);
  process.exit(1);
}

// --- build commit message --------------------------------------------------------
let msg = message;
if (!msg) {
  const lastTag = out(`git describe --tags --abbrev=0 2>/dev/null || true`);
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const subjects = out(`git log --oneline --no-merges ${range}`)
    .split("\n")
    .filter(Boolean)
    .map((s) => s.replace(/^[0-9a-f]{7,}\s+/, ""));
  if (subjects.length === 0) {
    msg = `release: v${ver}\n\nBump to v${ver}`;
  } else {
    const [first, ...rest] = subjects;
    msg = [first, ...(rest.length ? [`\n${rest.join("\n")}`] : []), `Bump to v${ver}`].join("\n");
  }
  console.log(`\n[release] auto commit message:\n---\n${msg}\n---`);
}

// --- commit + tag ----------------------------------------------------------------
console.log("\n[release] files to commit:");
console.log(out("git status --short") || "(none)");
run("git add -A");
execFileSync("git", ["commit", "-m", msg], { cwd: root, stdio: "inherit" });
run(`git tag v${ver}`);
console.log(`\n[release] committed & tagged v${ver}`);

// --- push --------------------------------------------------------------------------
if (noPush) {
  console.log(`[release] --no-push: skipping push. Tag v${ver} is local only.`);
} else {
  const branch = out("git branch --show-current") || "main";
  console.log(`\n[release] pushing to "${remote}" (branch ${branch} + tag v${ver})…`);
  run(`git push ${remote} ${branch}`);
  run(`git push ${remote} v${ver}`);
}

console.log(`\n[release] done. v${ver} released to "${remote}".`);
