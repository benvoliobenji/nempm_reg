#!/usr/bin/env node
// Validates the registry.
//
//   node scripts/validate.mjs                      offline checks for every file
//   node scripts/validate.mjs --base origin/main   also: version bumps + asset
//                                                  download/hash checks for files
//                                                  changed since that ref
//   node scripts/validate.mjs --verify-all         download and hash every asset
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  Problem,
  baseVersionOf,
  changedFiles,
  loadRegistry,
  loadSchemas,
  report,
  validateRegistry,
  verifyAsset,
  versionBumpProblem,
} from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    "verify-all": { type: "boolean", default: false },
  },
});

const registry = loadRegistry(root);
const problems = validateRegistry(registry, loadSchemas(root));

let toVerify = [];
if (values.base) {
  const changed = new Set(changedFiles(root, values.base));
  console.log(`Changed since ${values.base}: ${[...changed].join(", ") || "(none)"}`);
  for (const entry of [...registry.packages, ...registry.profiles]) {
    if (!changed.has(entry.file) || entry.error) continue;
    const bump = versionBumpProblem(entry.file, entry.data, baseVersionOf(root, values.base, entry.file));
    if (bump) problems.push(bump);
  }
  toVerify = registry.packages.filter((p) => changed.has(p.file) && !p.error);
}
if (values["verify-all"]) toVerify = registry.packages.filter((p) => !p.error);

for (const { file, data } of toVerify) {
  const assets = [["", data], ["data: ", data.data]].filter(([, asset]) => asset);
  for (const [label, asset] of assets) {
    console.log(`Verifying ${asset.url}`);
    for (const message of await verifyAsset(asset)) problems.push(new Problem(file, `${label}${message}`));
  }
}

if (problems.length > 0) {
  report(problems, root);
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log(`OK: ${registry.packages.length} package(s), ${registry.profiles.length} profile(s).`);
