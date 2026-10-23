// Shared registry logic: loading, schema + semantic validation, network
// verification of release assets, version-bump checks and index building.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import semver from "semver";

export const INDEX_SCHEMA_VERSION = 1;
const PLACEHOLDERS = new Set(["id", "version", "format"]);

/** A problem found in one registry file. */
export class Problem {
  constructor(file, message) {
    this.file = file;
    this.message = message;
  }
  toString() {
    return `${this.file}: ${this.message}`;
  }
}

export function loadSchemas(root) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  const read = (name) => JSON.parse(readFileSync(join(root, "schema", name), "utf8"));
  return {
    package: ajv.compile(read("package.schema.json")),
    profile: ajv.compile(read("profile.schema.json")),
  };
}

function readJsonDir(root, dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const file = join(dir, f).replaceAll("\\", "/");
      try {
        return { file, data: JSON.parse(readFileSync(join(full, f), "utf8")) };
      } catch (err) {
        return { file, error: `invalid JSON: ${err.message}` };
      }
    });
}

export function loadRegistry(root) {
  return {
    root,
    packages: readJsonDir(root, "packages"),
    profiles: readJsonDir(root, "profiles"),
  };
}

function schemaProblems(file, validate, data) {
  if (validate(data)) return [];
  return validate.errors.map(
    (e) => new Problem(file, `schema: ${e.instancePath || "(root)"} ${e.message}`),
  );
}

function templateProblems(file, label, template) {
  const out = [];
  for (const [, name] of template.matchAll(/\{([^}]*)\}/g)) {
    if (!PLACEHOLDERS.has(name)) out.push(new Problem(file, `${label} uses unknown placeholder {${name}}`));
  }
  const parts = template.split("/");
  if (template !== "" && parts.some((p) => p === "" || p === "." || p === "..")) {
    out.push(new Problem(file, `${label} "${template}" must not contain empty, "." or ".." segments`));
  }
  return out;
}

/** The folder a slot unpacks into ("" is the drive root), still templated. */
function extractDirOf(slot) {
  return slot.extractDir ?? (slot.path ? `${slot.path}/{id}` : "{id}");
}

function render(template, pkg) {
  return template.replaceAll("{id}", pkg.id).replaceAll("{version}", pkg.version).replaceAll("{format}", pkg.format);
}

/**
 * Where the slot's data file has to be inside the package's zip so that
 * unpacking puts it in place, or null when it lies outside the unpack folder.
 */
export function dataPathInZip(pkg, slot) {
  const dir = render(extractDirOf(slot), pkg);
  const dataFile = render(slot.dataFile, pkg);
  if (dir === "") return dataFile;
  return dataFile.toLowerCase().startsWith(`${dir.toLowerCase()}/`) ? dataFile.slice(dir.length + 1) : null;
}

/** Profile checks the schema can't express. */
export function profileProblems(file, profile) {
  const out = [];
  const reserved = new Set((profile.reserved ?? []).map((r) => r.toLowerCase()));
  const firstSegment = (p) => p.split("/")[0].toLowerCase();
  if (`${profile.id}.json` !== basename(file)) {
    out.push(new Problem(file, `id "${profile.id}" must match the file name`));
  }
  if (profile.naming?.pattern) {
    try {
      new RegExp(profile.naming.pattern);
    } catch (err) {
      out.push(new Problem(file, `naming.pattern is not a valid regex: ${err.message}`));
    }
  }
  for (const dir of profile.requiredDirs ?? []) {
    out.push(...templateProblems(file, `requiredDirs "${dir}"`, dir));
    if (dir.includes("{")) out.push(new Problem(file, `requiredDirs "${dir}" must not use placeholders`));
    if (reserved.has(firstSegment(dir))) out.push(new Problem(file, `requiredDirs "${dir}" is reserved`));
  }
  for (const [name, slot] of Object.entries(profile.slots ?? {})) {
    const label = `slot "${name}"`;
    out.push(...templateProblems(file, `${label} path`, slot.path));
    if (slot.file) out.push(...templateProblems(file, `${label} file`, slot.file));
    if (slot.path !== "" && reserved.has(firstSegment(slot.path))) {
      out.push(new Problem(file, `${label} path "${slot.path}" is inside a reserved folder`));
    }
    // Without {id} in the path or file name, two packages in one slot would
    // collide, unless the slot (or the whole drive) only ever holds one.
    const holdsOne = slot.max === 1 || profile.maxPackages === 1;
    if (slot.extract !== "never") {
      if (!slot.allow.includes("zip")) out.push(new Problem(file, `${label} extracts but does not allow zip`));
      // Empty means the drive root.
      const extractDir = extractDirOf(slot);
      out.push(...templateProblems(file, `${label} extractDir`, extractDir));
      if (!extractDir.includes("{id}") && !holdsOne) {
        out.push(new Problem(file, `${label} extractDir "${extractDir}" must contain {id}, or the slot needs max: 1`));
      }
      if (reserved.has(firstSegment(extractDir))) {
        out.push(new Problem(file, `${label} extractDir "${extractDir}" is inside a reserved folder`));
      }
    } else if (slot.extractDir) {
      out.push(new Problem(file, `${label} sets extractDir but extract is "never"`));
    }
    if (slot.allow.includes("tar") && slot.extract === "always") {
      out.push(new Problem(file, `${label} allows tar but extract is "always"; tar is never unpacked`));
    }
    if (!slot.file && !holdsOne && !slot.path.includes("{id}")) {
      out.push(new Problem(file, `${label} needs {id} in path or file, or max: 1`));
    }
    if (slot.file && !slot.file.includes("{id}") && !slot.path.includes("{id}") && !holdsOne) {
      out.push(new Problem(file, `${label} file "${slot.file}" has no {id}, so the slot needs max: 1`));
    }
    if (slot.dataFile !== undefined) {
      out.push(...templateProblems(file, `${label} dataFile`, slot.dataFile));
      if (slot.dataFile === "") out.push(new Problem(file, `${label} dataFile must name a file`));
      if (reserved.has(firstSegment(slot.dataFile))) {
        out.push(new Problem(file, `${label} dataFile "${slot.dataFile}" is inside a reserved folder`));
      }
      if (!slot.dataFile.includes("{id}") && !holdsOne) {
        out.push(new Problem(file, `${label} dataFile "${slot.dataFile}" has no {id}, so the slot needs max: 1`));
      }
    }
  }
  return out;
}

/** The `.../releases/download/<tag>/` part of a release asset URL. */
function releaseOf(url) {
  return url.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/)/)?.[1];
}

/** Package checks against the other packages and profiles. */
export function packageProblems(file, pkg, profilesById, packagesById) {
  const out = [];
  if (`${pkg.id}.json` !== basename(file)) {
    out.push(new Problem(file, `id "${pkg.id}" must match the file name`));
  }
  for (const profileId of pkg.profiles) {
    const profile = profilesById.get(profileId);
    if (!profile) {
      out.push(new Problem(file, `profile "${profileId}" does not exist`));
      continue;
    }
    if (profile.naming?.pattern && !new RegExp(profile.naming.pattern).test(pkg.id)) {
      out.push(new Problem(file, `id "${pkg.id}" does not match profile "${profileId}" naming ${profile.naming.pattern}`));
    }
    const slot = profile.slots[pkg.slot];
    if (!slot) {
      out.push(new Problem(file, `slot "${pkg.slot}" does not exist in profile "${profileId}"`));
      continue;
    }
    if (!slot.allow.includes(pkg.format)) {
      out.push(new Problem(file, `slot "${pkg.slot}" in profile "${profileId}" does not allow ${pkg.format}`));
    }
    if (pkg.extract && slot.extract === "never") {
      out.push(new Problem(file, `extract is true but slot "${pkg.slot}" in profile "${profileId}" never extracts`));
    }
    // The data file is either an asset of its own, or inside a zip that is
    // unpacked (the app then always unpacks it).
    if (slot.dataFile !== undefined && !pkg.data) {
      const where = `slot "${pkg.slot}" in profile "${profileId}"`;
      if (pkg.format !== "zip" || !pkg.extract) {
        out.push(
          new Problem(
            file,
            `${where} writes ${slot.dataFile}: publish it as "data" (an asset of the same release), or put it in the zip and set "extract": true`,
          ),
        );
      } else if (slot.extract !== "never" && dataPathInZip(pkg, slot) === null) {
        out.push(
          new Problem(
            file,
            `${where} unpacks into "${render(extractDirOf(slot), pkg)}", so a zip can't put ${slot.dataFile} in place; publish it as "data"`,
          ),
        );
      }
    }
    if (slot.dataFile === undefined && pkg.data) {
      out.push(new Problem(file, `slot "${pkg.slot}" in profile "${profileId}" has no data file, so remove "data"`));
    }
    const fat32Max = profile.maxFileBytes?.fat32;
    if (fat32Max && profile.filesystems.includes("fat32")) {
      for (const [label, size] of [["size", pkg.size], ["data.size", pkg.data?.size ?? 0]]) {
        if (size > fat32Max) {
          out.push(new Problem(file, `${label} ${size} exceeds FAT32's per-file limit; profile "${profileId}" must drop fat32`));
        }
      }
    }
  }
  if (pkg.data && releaseOf(pkg.data.url) !== releaseOf(pkg.url)) {
    out.push(new Problem(file, "data.url must be an asset of the same release as url"));
  }
  for (const req of pkg.requires ?? []) {
    if (req === pkg.id) out.push(new Problem(file, "a package cannot require itself"));
    else if (!packagesById.has(req)) out.push(new Problem(file, `required package "${req}" does not exist`));
  }
  return out;
}

/** Offline validation of the whole registry. Returns a list of problems. */
export function validateRegistry(registry, schemas) {
  const out = [];
  const profilesById = new Map();
  for (const { file, data, error } of registry.profiles) {
    if (error) {
      out.push(new Problem(file, error));
      continue;
    }
    const problems = schemaProblems(file, schemas.profile, data);
    out.push(...problems);
    if (problems.length === 0) {
      out.push(...profileProblems(file, data));
      profilesById.set(data.id, data);
    }
  }
  const valid = [];
  for (const entry of registry.packages) {
    if (entry.error) {
      out.push(new Problem(entry.file, entry.error));
      continue;
    }
    const problems = schemaProblems(entry.file, schemas.package, entry.data);
    out.push(...problems);
    if (problems.length === 0) valid.push(entry);
  }
  const packagesById = new Map(valid.map((p) => [p.data.id, p.data]));
  for (const { file, data } of valid) out.push(...packageProblems(file, data, profilesById, packagesById));
  const cores = new Map();
  for (const { data } of valid.filter((p) => p.data.core)) {
    for (const profileId of data.profiles) cores.set(profileId, [...(cores.get(profileId) ?? []), data.id]);
  }
  for (const [profileId, ids] of cores) {
    if (ids.length > 1) out.push(new Problem("packages/", `profile "${profileId}" has more than one core package: ${ids.join(", ")}`));
  }
  return out;
}

/** How much of a zip's end is kept for `inspect`: room for its file list. */
const ZIP_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * Downloads the asset and checks its size and SHA-256. Follows redirects
 * (GitHub sends release downloads to its object store). With `inspect`, the
 * end of a verified download is passed to it as (tail, offset of the tail in
 * the file), and the problems it returns are reported too.
 */
export async function verifyAsset(pkg, { fetchImpl = fetch, timeoutMs = 10 * 60 * 1000, inspect } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(pkg.url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) return [`URL returned HTTP ${res.status}`];
    const hash = createHash("sha256");
    let size = 0;
    const tail = [];
    let tailSize = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > pkg.size) return [`asset is larger than the declared size ${pkg.size}`];
      hash.update(chunk);
      if (inspect) {
        tail.push(chunk);
        tailSize += chunk.length;
        while (tailSize - tail[0].length >= ZIP_TAIL_BYTES) tailSize -= tail.shift().length;
      }
    }
    const out = [];
    if (size !== pkg.size) out.push(`size is ${size}, manifest says ${pkg.size}`);
    const sha = hash.digest("hex");
    if (sha !== pkg.sha256) out.push(`sha256 is ${sha}, manifest says ${pkg.sha256}`);
    if (out.length === 0 && inspect) out.push(...inspect(Buffer.concat(tail), size - tailSize));
    return out;
  } catch (err) {
    return [`URL not reachable: ${err.name === "AbortError" ? "timed out" : err.message}`];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The entries listed in a zip's central directory, as `/`-separated paths
 * the way the app reads them. `buf` is the end of the file, starting at byte
 * `start` of it (0 for the whole file).
 */
export function zipEntries(buf, start = 0) {
  const at = (offset, what) => {
    const i = offset - start;
    if (i < 0 || i + 4 > buf.length) throw new Error(`${what} is out of reach`);
    return i;
  };
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("no end of central directory");
  let count = buf.readUInt16LE(end + 10);
  let offset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    // ZIP64: a locator just before the end record points at the real one.
    const locator = end - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) throw new Error("damaged ZIP64 end record");
    const record = at(Number(buf.readBigUInt64LE(locator + 8)), "the ZIP64 end record");
    if (buf.readUInt32LE(record) !== 0x06064b50) throw new Error("damaged ZIP64 end record");
    count = Number(buf.readBigUInt64LE(record + 32));
    offset = Number(buf.readBigUInt64LE(record + 48));
  }
  const entries = [];
  let p = count > 0 ? at(offset, "the central directory") : 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged central directory");
    const utf8 = (buf.readUInt16LE(p + 8) & 0x800) !== 0;
    const nameLength = buf.readUInt16LE(p + 28);
    const raw = buf.subarray(p + 46, p + 46 + nameLength).toString(utf8 ? "utf8" : "latin1");
    const path = raw
      .split(/[\\/]/)
      .filter((part) => part && part !== ".")
      .join("/");
    entries.push({ path, dir: /[\\/]$/.test(raw) });
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

/**
 * Checks a downloaded zip against its slots' data file: a package without a
 * "data" asset must carry the file where unpacking puts it in place, and one
 * with the asset must not carry it too (the app refuses that).
 */
export function zipProblems(pkg, profilesById, tail, start = 0) {
  let files;
  try {
    files = zipEntries(tail, start).filter((e) => !e.dir).map((e) => e.path);
  } catch (err) {
    return [`asset is not a zip the validator can read: ${err.message}`];
  }
  const lower = new Set(files.map((f) => f.toLowerCase()));
  const out = new Set();
  for (const profileId of pkg.profiles) {
    const slot = profilesById.get(profileId)?.slots[pkg.slot];
    if (slot?.dataFile === undefined || slot.extract === "never") continue;
    const inZip = dataPathInZip(pkg, slot);
    if (inZip === null) continue;
    const has = lower.has(inZip.toLowerCase());
    if (!pkg.data && !has) {
      const name = inZip.split("/").pop().toLowerCase();
      const nested = files.find((f) => f.toLowerCase().endsWith(`/${name}`));
      out.add(
        `the zip has no ${inZip}` +
          (nested ? ` (it has ${nested}: zip the folder's contents, not the folder itself)` : "") +
          `, and there is no "data" asset`,
      );
    }
    if (pkg.data && has) out.add(`the zip contains ${inZip} and the release publishes it as "data" too; keep one`);
  }
  return [...out];
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Files under packages/ and profiles/ that differ from the base ref. */
export function changedFiles(root, baseRef) {
  const out = git(root, ["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`, "--", "packages", "profiles"]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The file's JSON as it exists on the base ref, or null if it is new. */
export function baseVersionOf(root, baseRef, file) {
  try {
    return JSON.parse(git(root, ["show", `${baseRef}:${file}`]));
  } catch {
    return null;
  }
}

/** A changed package or profile must have a higher version than on the base ref. */
export function versionBumpProblem(file, current, base) {
  if (!base) return null;
  if (file.startsWith("profiles/")) {
    if (!(current.version > base.version)) {
      return new Problem(file, `profile version must increase (base ${base.version}, now ${current.version})`);
    }
    return null;
  }
  if (!semver.valid(base.version)) return null;
  if (!semver.gt(current.version, base.version)) {
    return new Problem(file, `version must be higher than ${base.version} on the base branch (now ${current.version})`);
  }
  return null;
}

const stripSchemaKey = ({ $schema, ...rest }) => rest;

export function buildIndex(registry, now = new Date()) {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    packages: registry.packages.map((p) => stripSchemaKey(p.data)).sort((a, b) => a.id.localeCompare(b.id)),
    profiles: registry.profiles.map((p) => stripSchemaKey(p.data)).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Prints problems, as GitHub annotations when running in Actions. */
export function report(problems, root) {
  const inCi = process.env.GITHUB_ACTIONS === "true";
  for (const p of problems) {
    if (inCi) console.log(`::error file=${relative(process.cwd(), join(root, p.file))}::${p.message}`);
    else console.error(`✗ ${p}`);
  }
}
