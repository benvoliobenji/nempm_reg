// Finds the newest GitHub release of a package and plans its manifest update.
// autoupdate.mjs does the network and file work around this.
import semver from "semver";

/** The keys a package's rule in autoupdate.json may have. */
const RULE_KEYS = new Set(["skip", "repo", "asset", "tag", "version"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOf = (url) => decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));

/** Problems with autoupdate.json, given the ids of the registry's packages. */
export function ruleProblems(rules, packageIds) {
  if (!isObject(rules)) return ["must be an object of package ids to rules"];
  const out = [];
  for (const [id, rule] of Object.entries(rules)) {
    const where = `"${id}"`;
    if (!packageIds.has(id)) out.push(`${where}: no package has this id`);
    if (!isObject(rule)) {
      out.push(`${where}: must be an object`);
      continue;
    }
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) out.push(`${where}: unknown key "${key}"`);
    }
    if ("skip" in rule && typeof rule.skip !== "boolean") out.push(`${where}: skip must be true or false`);
    for (const key of ["repo", "asset", "tag", "version"]) {
      if (key in rule && typeof rule[key] !== "string") out.push(`${where}: ${key} must be a string`);
    }
    if (typeof rule.repo === "string" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rule.repo)) {
      out.push(`${where}: repo must be "owner/name"`);
    }
    for (const key of ["asset", "tag"]) {
      if (typeof rule[key] !== "string") continue;
      try {
        new RegExp(rule[key]);
      } catch (err) {
        out.push(`${where}: ${key} is not a valid regex: ${err.message}`);
      }
    }
    if ("version" in rule && !("tag" in rule)) out.push(`${where}: version needs a tag regex to fill it from`);
  }
  return out;
}

/** owner/repo of a GitHub release asset URL. */
export function repoOf(url) {
  return url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\//)?.[1];
}

/** The SHA-256 GitHub computed for a release asset, if it has one. */
export function digestOf(asset) {
  return asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
}

/**
 * Matches the same asset in other releases: its current name with every run
 * of version numbers (1, 0.8, 32.68) free to change. Case is ignored, since
 * some repos change it between releases (-usb.zip, then -USB.zip).
 */
export function assetPattern(name) {
  const source = name
    .split(/(\d+(?:\.\d+)*)/)
    .map((part, i) => (i % 2 ? String.raw`\d+(?:\.\d+)*` : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${source}$`, "i");
}

/**
 * The version a release tag stands for: the rule's "version" filled from its
 * "tag" regex groups, or else the first version in the tag (v1.4 is 1.4.0).
 * Null when the tag has none or doesn't match the rule.
 */
export function versionOf(tag, rule = {}) {
  let match;
  if (rule.tag) {
    match = new RegExp(rule.tag).exec(tag);
    if (!match) return null;
  }
  if (rule.version) return semver.valid(rule.version.replace(/\$(\d+)/g, (_, n) => match?.[n] ?? ""));
  return semver.coerce(tag, { includePrerelease: true })?.version ?? null;
}

/** The asset of `release` that stands for the one at `url` now, or a problem. */
function findAsset(release, url, override) {
  const pattern = override ? new RegExp(`^(?:${override})$`, "i") : assetPattern(nameOf(url));
  const matches = release.assets.filter((a) => pattern.test(a.name));
  if (matches.length === 1) return { asset: matches[0] };
  const names = (assets) => assets.map((a) => a.name).join(", ") || "none";
  return {
    problem:
      matches.length === 0
        ? `release ${release.tag_name} has no asset matching ${pattern} (it has: ${names(release.assets)})`
        : `release ${release.tag_name} has more than one asset matching ${pattern}: ${names(matches)}`,
  };
}

/** Whether a release asset is the file a manifest entry points at already. */
function sameFile(asset, entry) {
  const digest = digestOf(asset);
  return digest ? digest === entry.sha256 : asset.browser_download_url === entry.url;
}

/**
 * What to do with a package, given its repo's releases as the GitHub API
 * lists them. Only published releases count, not marked as pre-releases on
 * GitHub or in their version, and of those the one with the highest version.
 * Returns one of:
 *   { status: "current", release, version }
 *   { status: "update", release, version, asset, data }  (data: its NEMESIS.data asset, if the package has one)
 *   { status: "attention", message }
 */
export function planUpdate(pkg, releases, rule = {}) {
  let newest;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = versionOf(release.tag_name, rule);
    if (!version || semver.prerelease(version)) continue;
    if (!newest || semver.gt(version, newest.version)) newest = { release, version };
  }
  if (!newest) {
    const message = rule.tag ? `no release has a tag matching ${rule.tag}` : "no release has a tag that reads as a version";
    return { status: "attention", message };
  }
  const { release, version } = newest;
  const main = findAsset(release, pkg.url, rule.asset);
  if (main.problem) return { status: "attention", message: main.problem };
  const data = pkg.data ? findAsset(release, pkg.data.url) : {};
  if (data.problem) return { status: "attention", message: data.problem };
  if (semver.gt(version, pkg.version)) return { status: "update", release, version, asset: main.asset, data: data.asset };
  if (sameFile(main.asset, pkg) && (!pkg.data || sameFile(data.asset, pkg.data))) return { status: "current", release, version };
  return {
    status: "attention",
    message: `release ${release.tag_name} has new files but reads as version ${version}, not higher than ${pkg.version}; give the package a "tag" and "version" rule in autoupdate.json`,
  };
}

/**
 * The manifest after a planned update. `sha256` holds the new files' hashes
 * ({ asset, data }); `sourceRepo` is the owner/repo the releases came from.
 */
export function updatedManifest(pkg, plan, sha256, sourceRepo) {
  const next = structuredClone(pkg);
  next.version = plan.version;
  next.url = plan.asset.browser_download_url;
  next.sha256 = sha256.asset;
  next.size = plan.asset.size;
  if (pkg.data) next.data = { ...pkg.data, url: plan.data.browser_download_url, sha256: sha256.data, size: plan.data.size };
  // A homepage that is the package's own repo follows it when it is renamed or moved.
  const page = (repo) => `https://github.com/${repo}`;
  const home = pkg.homepage?.replace(/\/+$/, "").toLowerCase();
  if ([repoOf(pkg.url), sourceRepo].some((repo) => home === page(repo).toLowerCase())) next.homepage = page(repoOf(next.url));
  return next;
}

/**
 * JSON laid out the way the manifests are (Prettier's output for them): one
 * key per line, two-space indents, arrays of plain values on one line.
 */
export function formatManifest(value) {
  const format = (v, indent) => {
    if (!v || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v) && v.every((x) => !x || typeof x !== "object")) {
      return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    }
    const inner = `${indent}  `;
    const lines = Array.isArray(v)
      ? v.map((x) => inner + format(x, inner))
      : Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${format(x, inner)}`);
    const [open, close] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
    return lines.length === 0 ? open + close : `${open}\n${lines.join(",\n")}\n${indent}${close}`;
  };
  return `${format(value, "")}\n`;
}
