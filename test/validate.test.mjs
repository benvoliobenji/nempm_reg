import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  buildIndex,
  loadRegistry,
  loadSchemas,
  packageProblems,
  profileProblems,
  validateRegistry,
  verifyAsset,
  versionBumpProblem,
} from "../scripts/lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = loadSchemas(root);
const registry = loadRegistry(root);
const nemesis = registry.profiles.find((p) => p.data.id === "nemesis").data;
const zipPkg = registry.packages.find((p) => p.data.id === "example-tool").data;

const clone = (v) => structuredClone(v);
const profiles = new Map([["nemesis", nemesis]]);
const packages = new Map(registry.packages.map((p) => [p.data.id, p.data]));

test("the registry as committed validates", () => {
  assert.deepEqual(validateRegistry(registry, schemas).map(String), []);
});

test("schema: tar packages can never be extracted", () => {
  const core = clone(registry.packages.find((p) => p.data.core).data);
  core.extract = true;
  assert.equal(schemas.package(core), false);
});

test("schema: core packages must be tar", () => {
  const pkg = clone(zipPkg);
  pkg.core = true;
  assert.equal(schemas.package(pkg), false);
});

test("schema: only GitHub release URLs are accepted", () => {
  const pkg = clone(zipPkg);
  pkg.url = "https://example.com/tool.zip";
  assert.equal(schemas.package(pkg), false);
});

test("semantic: id must match the file name", () => {
  const problems = packageProblems("packages/other.json", zipPkg, profiles, packages);
  assert.match(problems.map(String).join("\n"), /must match the file name/);
});

test("semantic: slot must exist in each listed profile", () => {
  const pkg = clone(zipPkg);
  pkg.slot = "missing";
  const problems = packageProblems("packages/example-tool.json", pkg, profiles, packages);
  assert.match(problems.map(String).join("\n"), /slot "missing" does not exist/);
});

test("semantic: format must be allowed by the slot", () => {
  const pkg = clone(zipPkg);
  pkg.slot = "core";
  const problems = packageProblems("packages/example-tool.json", pkg, profiles, packages);
  assert.match(problems.map(String).join("\n"), /does not allow zip/);
});

test("semantic: unknown dependencies are rejected", () => {
  const pkg = clone(zipPkg);
  pkg.deps = ["nope"];
  const problems = packageProblems("packages/example-tool.json", pkg, profiles, packages);
  assert.match(problems.map(String).join("\n"), /dependency "nope" does not exist/);
});

test("semantic: dependency cycles are rejected", () => {
  const reg = clone(registry);
  reg.packages.find((p) => p.data.id === "nemesis-core").data.deps = ["example-tool"];
  assert.match(validateRegistry(reg, schemas).map(String).join("\n"), /dependency cycle/);
});

test("semantic: profile extractDir must contain {id}", () => {
  const profile = clone(nemesis);
  profile.slots.packages.extractDir = "packages/all";
  assert.match(profileProblems("profiles/nemesis.json", profile).map(String).join("\n"), /must contain \{id\}/);
});

test("semantic: slot paths cannot climb out of the drive", () => {
  const profile = clone(nemesis);
  profile.slots.packages.path = "packages/../..";
  assert.match(profileProblems("profiles/nemesis.json", profile).map(String).join("\n"), /must not contain/);
});

test("semantic: fixed file names need max: 1", () => {
  const profile = clone(nemesis);
  delete profile.slots.core.max;
  assert.match(profileProblems("profiles/nemesis.json", profile).map(String).join("\n"), /needs max: 1/);
});

test("version bump: same or lower version fails, higher passes, new file passes", () => {
  const file = "packages/example-tool.json";
  assert.ok(versionBumpProblem(file, { version: "1.0.0" }, { version: "1.0.0" }));
  assert.ok(versionBumpProblem(file, { version: "0.9.0" }, { version: "1.0.0" }));
  assert.equal(versionBumpProblem(file, { version: "1.0.1" }, { version: "1.0.0" }), null);
  assert.equal(versionBumpProblem(file, { version: "1.0.0" }, null), null);
  assert.ok(versionBumpProblem("profiles/nemesis.json", { version: 1 }, { version: 1 }));
});

test("index: merges packages and profiles without $schema keys", () => {
  const index = buildIndex(registry, new Date("2026-01-01T00:00:00Z"));
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(index.packages.length, registry.packages.length);
  assert.ok(index.packages.every((p) => !("$schema" in p)));
  assert.ok(index.profiles.every((p) => !("$schema" in p)));
});

// The gate for Phase 1: a manifest with the wrong hash must fail.
test("asset verification: matching hash passes, wrong hash and wrong size fail", async (t) => {
  const body = Buffer.from("pretend this is a zip");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const server = createServer((req, res) => {
    if (req.url === "/asset") {
      res.writeHead(200, { "content-length": body.length });
      res.end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/asset`;

  assert.deepEqual(await verifyAsset({ url, sha256, size: body.length }), []);

  const wrongHash = await verifyAsset({ url, sha256: "0".repeat(64), size: body.length });
  assert.match(wrongHash.join("\n"), /sha256 is/);

  const wrongSize = await verifyAsset({ url, sha256, size: body.length + 1 });
  assert.match(wrongSize.join("\n"), /size is/);

  const missing = await verifyAsset({ url: `${url}-missing`, sha256, size: 1 });
  assert.match(missing.join("\n"), /HTTP 404/);
});
