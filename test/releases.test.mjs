import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadRegistry } from "../scripts/lib.mjs";
import {
  assetPattern,
  formatManifest,
  planUpdate,
  repoOf,
  ruleProblems,
  updatedManifest,
  versionOf,
} from "../scripts/releases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = loadRegistry(root);
const rules = JSON.parse(readFileSync(join(root, "autoupdate.json"), "utf8"));

const sha = (c) => c.repeat(64);

/** A release as the GitHub API lists it; `files` maps asset names to a hash character. */
function release(tag, files, extra = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/owner/tool/releases/tag/${tag}`,
    assets: Object.entries(files).map(([name, c]) => ({
      name,
      size: 100,
      digest: `sha256:${sha(c)}`,
      browser_download_url: `https://github.com/owner/tool/releases/download/${tag}/${name}`,
    })),
    ...extra,
  };
}

const pkg = {
  id: "tool",
  version: "1.0.0",
  url: "https://github.com/owner/tool/releases/download/v1.0.0/tool-1.0.0-usb.zip",
  sha256: sha("1"),
  size: 100,
  homepage: "https://github.com/owner/tool",
};

test("autoupdate.json as committed is valid", () => {
  const ids = new Set(registry.packages.map((p) => p.data.id));
  assert.deepEqual(ruleProblems(rules, ids), []);
});

test("rules: unknown packages and keys, wrong types and bad regexes are reported", () => {
  const problems = ruleProblems(
    { nope: {}, tool: { skip: "yes", repo: "just-a-name", tag: "(", asset: 1, extra: true }, other: { version: "$1.0.0" } },
    new Set(["tool", "other"]),
  ).join("\n");
  assert.match(problems, /"nope": no package has this id/);
  assert.match(problems, /"tool": unknown key "extra"/);
  assert.match(problems, /"tool": skip must be true or false/);
  assert.match(problems, /"tool": repo must be "owner\/name"/);
  assert.match(problems, /"tool": tag is not a valid regex/);
  assert.match(problems, /"tool": asset must be a string/);
  assert.match(problems, /"other": version needs a tag regex/);
});

test("asset pattern: finds the same asset in a later release, among the names real package repos use", () => {
  // [the registry's asset, later names that are it, names of its siblings in the same release]
  const cases = [
    ["media.codecs-2.0.2-usb.zip", ["media.codecs-2.0.3-usb.zip", "media.codecs-2.1-usb.zip"], ["media.codecs-2.0.2.zip", "media.codecs-2.0.2-usb.zip.sha256"]],
    ["dashcam-0.8-usb.zip", ["dashcam-0.15.6-usb.zip"], ["dashcam-0.15.6.zip", "DashcamPlayer.apk", "SHA256SUMS"]],
    ["smarttube-32.68-gen5w.5-usb.zip", ["smarttube-32.69-gen5w.1-usb.zip"], ["smarttube-32.68-gen5w.5.zip", "smarttube-gen5w-armeabi-v7a.apk"]],
    ["hkmc.factory82.bootready-v4.2.USB.zip", ["hkmc.factory82.bootready-v4.3.USB.zip"], ["hkmc.factory82.bootready-v4.2.nemesis.zip", "hkmc.factory82.bootready-v4.2.source.zip"]],
    ["HMG_Leafia_Plus_Wireless_CarPlay_AA-v1.0.5.zip", ["HMG_Leafia_Plus_Wireless_CarPlay_AA-v1.1.0.zip"], ["leafia-kit-full-v1.0.5.zip", "leafia-kit-v1.0.5.zip"]],
    ["Hacker.Keyboard.USB.v1.zip", ["Hacker.Keyboard.USB.v2.zip", "Hacker.Keyboard.USB.v1.1.zip"], ["Hyundai.Keyboard.Restore.USB.v1.zip", "KeyBridge.USB.v1.zip"]],
    ["Launchpad-install-usb.zip", ["Launchpad-install-usb.zip"], ["Launchpad-port-kit-usb.zip", "Launchpad-update-usb.zip", "paytondev.launchpad.zip"]],
    ["Tilepad-install-usb.zip", ["Tilepad-install-usb.zip"], ["Tilepad-uninstall-usb.zip", "Tilepad-update-usb.zip", "tilepad.zip"]],
    ["hkmc-coldstart-heat-usb.zip", ["hkmc-coldstart-heat-USB.zip"], ["coldstart.heat.zip"]],
    ["ota_package.tar", ["ota_package.tar"], ["ota_package.tar.sha256"]],
  ];
  for (const [name, same, siblings] of cases) {
    const pattern = assetPattern(name);
    for (const later of same) assert.ok(pattern.test(later), `${name} should match ${later}`);
    for (const sibling of siblings) assert.ok(!pattern.test(sibling), `${name} should not match ${sibling}`);
  }
});

test("version: the first version in the tag, or one made by a rule", () => {
  assert.equal(versionOf("1.0.0"), "1.0.0");
  assert.equal(versionOf("v4.2"), "4.2.0");
  assert.equal(versionOf("v0.15.6"), "0.15.6");
  assert.equal(versionOf("0.1-beta"), "0.1.0-beta");
  assert.equal(versionOf("latest"), null);
  // Read as a pre-release of 32.68.0 without the rule, so it could never update.
  assert.equal(versionOf("v32.68-gen5w.5"), "32.68.0-gen5w.5");
  assert.equal(versionOf("v32.68-gen5w.5", rules["gen5-smarttube"]), "32.68.5");
  assert.equal(versionOf("v32.69-gen5w.1", rules["gen5-smarttube"]), "32.69.1");
  assert.equal(versionOf("v32.69", rules["gen5-smarttube"]), null, "a tag the rule doesn't match");
});

test("plan: the highest stable version wins, whatever order the releases come in", () => {
  const plan = planUpdate(pkg, [
    release("v3.0.0", { "tool-3.0.0-usb.zip": "3" }, { draft: true }),
    release("v2.5.0", { "tool-2.5.0-usb.zip": "3" }, { prerelease: true }),
    release("v2.1.0-rc.1", { "tool-2.1.0-rc.1-usb.zip": "3" }),
    release("v1.5.0", { "tool-1.5.0-usb.zip": "3" }),
    release("v2.0", { "tool-2.0-usb.zip": "2", "tool-2.0.zip": "4", "tool-2.0-usb.zip.sha256": "5" }),
    release("v1.0.0", { "tool-1.0.0-usb.zip": "1" }),
  ]);
  assert.equal(plan.status, "update");
  assert.equal(plan.version, "2.0.0");
  assert.equal(plan.asset.name, "tool-2.0-usb.zip");
});

test("plan: current when the newest release is the one the manifest points at", () => {
  const releases = [release("v1.0.0", { "tool-1.0.0-usb.zip": "1" }), release("v0.9.0", { "tool-0.9.0-usb.zip": "9" })];
  assert.equal(planUpdate(pkg, releases).status, "current");
  // The repo was renamed: same file under a new URL.
  const renamed = release("v1.0.0", { "tool-1.0.0-usb.zip": "1" });
  renamed.assets[0].browser_download_url = "https://github.com/owner/new-name/releases/download/v1.0.0/tool-1.0.0-usb.zip";
  assert.equal(planUpdate(pkg, [renamed]).status, "current");
});

test("plan: a release that doesn't fit is left for a person to look at", () => {
  const message = (releases, rule) => {
    const plan = planUpdate(pkg, releases, rule);
    assert.equal(plan.status, "attention");
    return plan.message;
  };
  assert.match(message([release("v2.0.0", { "tool.zip": "2", "notes.txt": "3" })]), /has no asset matching .* \(it has: tool\.zip, notes\.txt\)/);
  assert.match(message([release("v2.0.0", { "tool-2.0.0-usb.zip": "2", "tool-2-usb.zip": "3" })]), /more than one asset matching/);
  assert.match(message([release("v1.0", { "tool-1.0-usb.zip": "2" })]), /new files but reads as version 1\.0\.0, not higher than 1\.0\.0/);
  assert.match(message([release("latest", { "tool-usb.zip": "2" })]), /no release has a tag that reads as a version/);
  assert.match(message([release("v2.0.0", { "tool-2.0.0-usb.zip": "2" })], { tag: "^tool-v" }), /no release has a tag matching/);
});

test("plan: rules pick one package's releases out of a shared repo and name its asset", () => {
  const releases = [
    release("other-v9.0.0", { "other-9.0.0-usb.zip": "9" }),
    release("tool-v1.2.0", { "tool-1.2.0-usb.zip": "2", "tool-1.2.0-full-usb.zip": "3" }),
  ];
  const plan = planUpdate(pkg, releases, { tag: "^tool-v(.+)$", version: "$1", asset: String.raw`tool-[\d.]+-usb\.zip` });
  assert.equal(plan.status, "update");
  assert.equal(plan.version, "1.2.0");
  assert.equal(plan.asset.name, "tool-1.2.0-usb.zip");
});

test("plan: a package with a data file needs it in the same release", () => {
  const withData = { ...pkg, data: { url: "https://github.com/owner/tool/releases/download/v1.0.0/NEMESIS.data", sha256: sha("d"), size: 10 } };
  const plan = planUpdate(withData, [release("v1.1.0", { "tool-1.1.0-usb.zip": "2", "NEMESIS.data": "e" })]);
  assert.equal(plan.status, "update");
  assert.equal(plan.data.name, "NEMESIS.data");
  assert.match(planUpdate(withData, [release("v1.1.0", { "tool-1.1.0-usb.zip": "2" })]).message, /no asset matching/);
});

test("updated manifest: new version and files, a homepage that follows its moved repo", () => {
  const plan = planUpdate(pkg, [release("v1.1.0", { "tool-1.1.0-usb.zip": "2" })]);
  plan.asset.browser_download_url = "https://github.com/new-owner/tool/releases/download/v1.1.0/tool-1.1.0-usb.zip";
  const next = updatedManifest(pkg, plan, { asset: sha("2") }, "new-owner/tool");
  assert.deepEqual(next, {
    ...pkg,
    version: "1.1.0",
    url: "https://github.com/new-owner/tool/releases/download/v1.1.0/tool-1.1.0-usb.zip",
    sha256: sha("2"),
    homepage: "https://github.com/new-owner/tool",
  });
  assert.equal(repoOf(next.url), "new-owner/tool");
  // A homepage elsewhere is the publisher's choice and stays.
  const site = updatedManifest({ ...pkg, homepage: "https://tool.example.com" }, plan, { asset: sha("2") }, "owner/tool");
  assert.equal(site.homepage, "https://tool.example.com");
});

test("format: every manifest comes back byte for byte, so updates only touch what changed", () => {
  for (const { file } of registry.packages) {
    // As Git stores it (.gitattributes), whatever an editor on Windows saved.
    const text = readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n");
    assert.equal(formatManifest(JSON.parse(text)), text, file);
  }
});
