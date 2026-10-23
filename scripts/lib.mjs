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
      const extractDir = slot.extractDir ?? (slot.path ? `${slot.path}/{id}` : "{id}");
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
    if (slot.dataFile !== undefined && !pkg.data) {
      out.push(
        new Problem(
          file,
          `slot "${pkg.slot}" in profile "${profileId}" writes ${slot.dataFile}, so the package needs "data": the ${slot.dataFile} asset from its release`,
        ),
      );
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

/**
 * Downloads the asset and checks its size and SHA-256. Follows redirects
 * (GitHub sends release downloads to its object store).
 */
export async function verifyAsset(pkg, { fetchImpl = fetch, timeoutMs = 10 * 60 * 1000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(pkg.url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) return [`URL returned HTTP ${res.status}`];
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > pkg.size) return [`asset is larger than the declared size ${pkg.size}`];
      hash.update(chunk);
    }
    const out = [];
    if (size !== pkg.size) out.push(`size is ${size}, manifest says ${pkg.size}`);
    const sha = hash.digest("hex");
    if (sha !== pkg.sha256) out.push(`sha256 is ${sha}, manifest says ${pkg.sha256}`);
    return out;
  } catch (err) {
    return [`URL not reachable: ${err.name === "AbortError" ? "timed out" : err.message}`];
  } finally {
    clearTimeout(timer);
  }
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
