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
  zipEntries,
  zipProblems,
} from "../scripts/lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = loadSchemas(root);
const registry = loadRegistry(root);
const nemesis = registry.profiles.find((p) => p.data.id === "nemesis").data;
const zipPkg = registry.packages.find((p) => p.data.id === "example-tool").data;

const clone = (v) => structuredClone(v);

/** A zip with stored (uncompressed) entries; CRCs are left at 0. */
function makeZip(files, { zip64 = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, body = ""] of files) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : files.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  const zip64Parts = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(files.length), 24);
    record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    zip64Parts.push(record, locator);
  }
  return Buffer.concat([...local, directory, ...zip64Parts, end]);
}

/** example-tool as a release with just a zip that carries NEMESIS.data. */
function zipOnly() {
  const pkg = clone(zipPkg);
  delete pkg.data;
  pkg.extract = true;
  return pkg;
}

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

test("semantic: unknown required packages are rejected", () => {
  const pkg = clone(zipPkg);
  pkg.requires = ["nope"];
  const problems = packageProblems("packages/example-tool.json", pkg, profiles, packages);
  assert.match(problems.map(String).join("\n"), /required package "nope" does not exist/);
});

test("semantic: a tool in a slot with a dataFile must publish its NEMESIS.data or unpack it", () => {
  const pkg = clone(zipPkg);
  delete pkg.data;
  const problems = packageProblems("packages/example-tool.json", pkg, profiles, packages);
  assert.match(problems.map(String).join("\n"), /publish it as "data".*"extract": true/);
});

test("semantic: an unpacked zip may carry NEMESIS.data instead of a data asset", () => {
  assert.deepEqual(packageProblems("packages/example-tool.json", zipOnly(), profiles, packages).map(String), []);

  // Not when the zip unpacks into a folder the data file isn't in.
  const profile = clone(nemesis);
  profile.slots.packages.extractDir = "packages/{id}";
  const problems = packageProblems("packages/example-tool.json", zipOnly(), new Map([["nemesis", profile]]), packages);
  assert.match(problems.map(String).join("\n"), /unpacks into "packages\/example-tool", so a zip can't put NEMESIS.data/);
});

test("zip entries: read from the central directory, ZIP64 included, from the whole file or its end", () => {
  const files = [["NEMESIS.data", "data"], ["launchpad/"], ["launchpad\\install.sh", "#!/bin/sh"], ["./packages/x.zip", "x"]];
  const expected = [
    { path: "NEMESIS.data", dir: false },
    { path: "launchpad", dir: true },
    { path: "launchpad/install.sh", dir: false },
    { path: "packages/x.zip", dir: false },
  ];
  for (const zip64 of [false, true]) {
    const zip = makeZip(files, { zip64 });
    assert.deepEqual(zipEntries(zip), expected, `whole file, zip64: ${zip64}`);
    const cut = 40;
    assert.deepEqual(zipEntries(zip.subarray(cut), cut), expected, `its end, zip64: ${zip64}`);
  }
  // An end that starts after the central directory can't be read.
  const zip = makeZip(files);
  assert.throws(() => zipEntries(zip.subarray(zip.length - 22), zip.length - 22), /out of reach/);
  assert.throws(() => zipEntries(Buffer.from("not a zip")), /no end of central directory/);
});

test("zip inspection: NEMESIS.data comes from exactly one place, at the zip's top level", () => {
  const check = (pkg, files) => zipProblems(pkg, profiles, makeZip(files)).join("\n");
  assert.equal(check(zipOnly(), [["NEMESIS.data", "d"], ["launchpad/install.sh", "x"]]), "");
  assert.equal(check(zipOnly(), [["nemesis.DATA", "d"]]), "", "FAT ignores case");
  assert.match(check(zipOnly(), [["launchpad/install.sh", "x"]]), /the zip has no NEMESIS.data, and there is no "data" asset/);
  assert.match(
    check(zipOnly(), [["Launchpad-install-usb/NEMESIS.data", "d"]]),
    /it has Launchpad-install-usb\/NEMESIS.data: zip the folder's contents, not the folder itself/,
  );
  assert.match(check(clone(zipPkg), [["NEMESIS.data", "d"]]), /publishes it as "data" too; keep one/);
  assert.equal(check(clone(zipPkg), [["packages/inner.zip", "x"]]), "");
  assert.match(zipProblems(zipOnly(), profiles, Buffer.from("nope")).join(), /not a zip the validator can read/);
});

test("semantic: the data asset must come from the same release", () => {
  const pkg = clone(zipPkg);
  pkg.data.url = "https://github.com/OWNER/example-tool/releases/download/v0.9.0/NEMESIS.data";
  const problems = packageProblems("packages/example-tool.json", pkg, profiles, packages);
  assert.match(problems.map(String).join("\n"), /same release/);
});

test("schema + semantic: the core can't carry a data file", () => {
  const core = clone(registry.packages.find((p) => p.data.core).data);
  core.data = clone(zipPkg.data);
  assert.equal(schemas.package(core), false);
  const problems = packageProblems("packages/nemesis-core.json", core, profiles, packages);
  assert.match(problems.map(String).join("\n"), /remove "data"/);
});

test("schema: ids may contain dots, but not leading, trailing or doubled", () => {
  const pkg = clone(zipPkg);
  pkg.id = "my.tool";
  assert.equal(schemas.package(pkg), true);
  assert.deepEqual(packageProblems("packages/my.tool.json", pkg, profiles, packages).map(String), []);
  for (const bad of ["my..tool", ".tool", "tool.", "My.Tool"]) {
    assert.equal(schemas.package({ ...pkg, id: bad }), false, bad);
  }
});

test("semantic: extractDir needs {id} unless the drive holds one package", () => {
  assert.equal(nemesis.slots.packages.extractDir, "", "Nemesis unpacks into the drive root");
  const profile = clone(nemesis);
  delete profile.maxPackages;
  profile.slots.packages.extractDir = "packages/all";
  assert.match(profileProblems("profiles/nemesis.json", profile).map(String).join("\n"), /must contain \{id\}/);
});

test("semantic: slot paths cannot climb out of the drive", () => {
  const profile = clone(nemesis);
  profile.slots.packages.path = "packages/../..";
  assert.match(profileProblems("profiles/nemesis.json", profile).map(String).join("\n"), /must not contain/);
});

test("semantic: fixed file names need max: 1 unless the drive holds one package", () => {
  assert.deepEqual(profileProblems("profiles/nemesis.json", nemesis).map(String), []);
  const profile = clone(nemesis);
  delete profile.maxPackages;
  const problems = profileProblems("profiles/nemesis.json", profile).map(String).join("\n");
  assert.match(problems, /slot "core" needs \{id\} in path or file, or max: 1/);
  assert.match(problems, /dataFile "NEMESIS.data" has no \{id\}/);
});

test("version bump: same or lower version fails, higher passes, new file passes", () => {
  const file = "packages/example-tool.json";
  assert.ok(versionBumpProblem(file, { version: "1.0.0" }, { version: "1.0.0" }));
  assert.ok(versionBumpProblem(file, { version: "0.9.0" }, { version: "1.0.0" }));
  assert.equal(versionBumpProblem(file, { version: "1.0.1" }, { version: "1.0.0" }), null);
  assert.equal(versionBumpProblem(file, { version: "1.0.0" }, null), null);
  assert.ok(versionBumpProblem("profiles/nemesis.json", { version: 2 }, { version: 2 }));
  assert.equal(versionBumpProblem("profiles/nemesis.json", { version: 2 }, { version: 1 }), null);
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

test("asset verification: a verified zip's end goes to inspect", async (t) => {
  const body = makeZip([["launchpad/install.sh", "x".repeat(64 * 1024)]]);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-length": body.length });
    // In pieces, the way a real download arrives.
    for (let i = 0; i < body.length; i += 1000) res.write(body.subarray(i, i + 1000));
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const asset = { url: `http://127.0.0.1:${server.address().port}/tool.zip`, sha256, size: body.length };

  const inspect = (tail, start) => zipProblems(zipOnly(), profiles, tail, start);
  assert.match((await verifyAsset(asset, { inspect })).join("\n"), /the zip has no NEMESIS.data/);
  let inspected = false;
  const wrong = await verifyAsset({ ...asset, sha256: "0".repeat(64) }, { inspect: () => ((inspected = true), []) });
  assert.match(wrong.join("\n"), /sha256 is/);
  assert.equal(inspected, false, "only a verified download is inspected");
});
