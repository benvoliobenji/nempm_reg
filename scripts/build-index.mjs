#!/usr/bin/env node
// Builds dist/ for GitHub Pages: index.json (all manifests and profiles) plus
// the schemas. Refuses to build if the registry does not validate.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { buildIndex, loadRegistry, loadSchemas, report, validateRegistry } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const registry = loadRegistry(root);
const problems = validateRegistry(registry, loadSchemas(root));
if (problems.length > 0) {
  report(problems, root);
  process.exit(1);
}

const index = buildIndex(registry);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
cpSync(join(root, "schema"), join(dist, "schema"), { recursive: true });
writeFileSync(join(dist, ".nojekyll"), "");
console.log(`Wrote dist/index.json: ${index.packages.length} package(s), ${index.profiles.length} profile(s).`);
