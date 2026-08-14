// Sync the app version from package.json (single source of truth) into the
// other two places that carry a version string: src-tauri/Cargo.toml and
// src-tauri/tauri.conf.json.
//
// Run automatically by the `version` npm lifecycle script after `npm version`
// bumps package.json, so a single `npm version patch` updates all three files
// and the resulting git tag drives the release workflow.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync-version] unexpected version format: ${version}`);
  process.exit(1);
}

// Cargo.toml: only the `[package] version = "..."` line starts a line with
// `version =` (dependency versions are written as `name = { version = "..." }`
// and are never matched by this anchored pattern).
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
const cargo = readFileSync(cargoPath, 'utf8');
let cargoMatched = false;
const cargoNext = cargo.replace(/^version = ".*"$/m, () => {
  cargoMatched = true;
  return `version = "${version}"`;
});
if (!cargoMatched) {
  console.error('[sync-version] could not find `version = "..."` in Cargo.toml');
  process.exit(1);
}
writeFileSync(cargoPath, cargoNext);

// tauri.conf.json: the only `"version": "..."` field.
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const conf = readFileSync(confPath, 'utf8');
let confMatched = false;
const confNext = conf.replace(/"version":\s*".*?"/, () => {
  confMatched = true;
  return `"version": "${version}"`;
});
if (!confMatched) {
  console.error('[sync-version] could not find "version" in tauri.conf.json');
  process.exit(1);
}
writeFileSync(confPath, confNext);

console.log(`[sync-version] synced version ${version} -> Cargo.toml, tauri.conf.json`);
