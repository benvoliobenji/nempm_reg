#!/usr/bin/env node
// Moves each package to its repo's newest GitHub release.
//
//   node scripts/autoupdate.mjs                   update every package
//   node scripts/autoupdate.mjs --dry-run         report what would change, write nothing
//   node scripts/autoupdate.mjs --only <id>       just this package (repeatable)
//   node scripts/autoupdate.mjs --message <file>  also write a commit message there
//
// A new release is checked the way validate.mjs checks a PR (GitHub's digest
// and size of each file, the zip's NEMESIS.data, the schema) before its
// manifest is written. autoupdate.json holds rules for packages whose releases
// don't fit the defaults; see CONTRIBUTING.md. GITHUB_TOKEN raises the API rate
// limit. Exits 1 when a package needs a person to look at it, after updating
// the others.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Problem, loadRegistry, loadSchemas, report, validateRegistry, verifyAsset, zipProblems } from "./lib.mjs";
import { digestOf, formatManifest, planUpdate, repoOf, ruleProblems, updatedManifest } from "./releases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    only: { type: "string", multiple: true },
    message: { type: "string" },
  },
});
const dryRun = values["dry-run"];

/** A repo's releases, newest first. */
async function listReleases(repo) {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(60 * 1000),
  });
  if (res.status === 404) throw new Error(`GitHub has no repo ${repo}; if it moved, set its "repo" in autoupdate.json`);
  if (!res.ok) throw new Error(`the GitHub API returned HTTP ${res.status} for ${repo}`);
  return res.json();
}

/** An asset's SHA-256: GitHub's digest, or a download's when GitHub has none. */
async function sha256Of(asset) {
  const digest = digestOf(asset);
  if (digest) return digest;
  const res = await fetch(asset.browser_download_url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error(`${asset.name} returned HTTP ${res.status}`);
  const hash = createHash("sha256");
  for await (const chunk of res.body) hash.update(chunk);
  return hash.digest("hex");
}

const registry = loadRegistry(root);
const schemas = loadSchemas(root);
const rulesFile = join(root, "autoupdate.json");
const rules = existsSync(rulesFile) ? JSON.parse(readFileSync(rulesFile, "utf8")) : {};
const ruleIssues = ruleProblems(rules, new Set(registry.packages.filter((p) => !p.error).map((p) => p.data.id)));
if (ruleIssues.length > 0) {
  report(ruleIssues.map((message) => new Problem("autoupdate.json", message)), root);
  process.exit(1);
}
const profilesById = new Map(registry.profiles.filter((p) => !p.error).map((p) => [p.data.id, p.data]));

const updated = [];
const current = [];
const skipped = [];
const problems = [];

// A package with invalid JSON is left to validate.mjs to report.
for (const entry of registry.packages.filter((p) => !p.error)) {
  const pkg = entry.data;
  if (values.only && !values.only.includes(pkg.id)) continue;
  const rule = rules[pkg.id] ?? {};
  if (rule.skip) {
    skipped.push(pkg.id);
    console.log(`- ${pkg.id}: skipped by autoupdate.json`);
    continue;
  }
  const repo = rule.repo ?? repoOf(pkg.url);
  const attention = (message) => problems.push(new Problem(entry.file, message));

  let plan;
  try {
    plan = planUpdate(pkg, await listReleases(repo), rule);
  } catch (err) {
    attention(`can't list releases: ${err.message}`);
    continue;
  }
  if (plan.status === "attention") {
    attention(plan.message);
    continue;
  }
  if (plan.status === "current") {
    current.push(pkg.id);
    console.log(`= ${pkg.id} ${pkg.version} is current (${plan.release.tag_name})`);
    continue;
  }

  const tag = plan.release.tag_name;
  console.log(`Checking ${pkg.id} ${tag}: ${plan.asset.browser_download_url}`);
  let next;
  try {
    const sha256 = { asset: await sha256Of(plan.asset), data: plan.data && (await sha256Of(plan.data)) };
    next = updatedManifest(pkg, plan, sha256, repo);
  } catch (err) {
    attention(`${tag}: ${err.message}`);
    continue;
  }
  // The same checks validate.mjs runs on a PR that changes this manifest.
  const inspect = next.format === "zip" ? (tail, start) => zipProblems(next, profilesById, tail, start) : undefined;
  const issues = await verifyAsset(next, { inspect });
  if (next.data) issues.push(...(await verifyAsset(next.data)).map((message) => `data: ${message}`));
  const trial = { ...registry, packages: registry.packages.map((p) => (p === entry ? { file: p.file, data: next } : p)) };
  issues.push(...validateRegistry(trial, schemas).filter((p) => p.file === entry.file).map((p) => p.message));
  if (issues.length > 0) {
    for (const message of issues) attention(`${tag}: ${message}`);
    continue;
  }

  if (!dryRun) writeFileSync(join(root, entry.file), formatManifest(next));
  updated.push({ id: pkg.id, from: pkg.version, to: next.version, release: plan.release });
  console.log(`↑ ${pkg.id} ${pkg.version} → ${next.version} (${tag})`);
}

if (values.message && !dryRun && updated.length > 0) {
  const subject =
    updated.length === 1
      ? `feat(registry): update ${updated[0].id} to ${updated[0].to}`
      : `feat(registry): update ${updated.length} packages`;
  const body = updated.map((u) => `- ${u.id} ${u.from} → ${u.to}: ${u.release.html_url}`).join("\n");
  writeFileSync(values.message, `${subject}\n\nFrom each package's newest GitHub release.\n\n${body}\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ["## Package updates", ""];
  if (updated.length > 0) {
    lines.push("| Package | From | To | Release |", "| --- | --- | --- | --- |");
    for (const u of updated) lines.push(`| ${u.id} | ${u.from} | ${u.to} | [${u.release.tag_name}](${u.release.html_url}) |`);
  } else {
    lines.push("No package has a new release.");
  }
  if (problems.length > 0) {
    lines.push("", "### Not updated, needs a look", "");
    for (const p of problems) lines.push(`- \`${p.file}\`: ${p.message}`);
  }
  lines.push("", `Current: ${current.join(", ") || "none"}. Skipped: ${skipped.join(", ") || "none"}.`, "");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

const verb = dryRun ? "would update" : "updated";
if (problems.length > 0) {
  report(problems, root);
  const count = new Set(problems.map((p) => p.file)).size;
  console.error(`\n${verb} ${updated.length} package(s); ${count} need(s) a look and ${count === 1 ? "was" : "were"} left as is.`);
  process.exit(1);
}
console.log(`\nOK: ${verb} ${updated.length} package(s).`);
