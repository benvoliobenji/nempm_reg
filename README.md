# pkgmgr registry

The database behind the Nemesis Package Manager app. It is a plain Git repo of
JSON files, in the spirit of a Scoop bucket:

```
packages/<id>.json          one manifest per package
profiles/<device>.json      the USB layout each target device expects
schema/*.schema.json        JSON Schema (2020-12) for both
scripts/                    validate.mjs, build-index.mjs, lib.mjs
test/                       unit tests for the validator
.github/workflows/          validate.yml (PRs), publish-index.yml (Pages)
```

On every merge to `main`, CI merges all manifests and profiles into one
`index.json` and deploys it to GitHub Pages. The app only ever downloads that
file plus the release assets it points to, so it never touches the GitHub API
and never hits its rate limits.

To add or update a package, see [CONTRIBUTING.md](CONTRIBUTING.md).

## The Nemesis profile

[`profiles/nemesis.json`](profiles/nemesis.json) describes the drive layout:

```
<drive root>/
  NEMESIS.data            the core package (a .tar, written as-is, never unpacked)
  packages/
    <tool>.zip            one zip per tool package
  .pkgmgr/manifest.json   written by the app: what is installed, and where
```

A zip package can optionally be unpacked to `packages/<tool>/` instead, if a
user switches **Extract** on for that install. The profile's `version` must be
bumped whenever the layout changes; the app sees the new version and offers to
migrate drives that were written with the old one.

## One-time GitHub setup

1. Push this repo to GitHub as `OWNER/pkgmgr-registry`, then replace `OWNER`
   in `.github/CODEOWNERS` and in the schema `$id`s.
2. **Settings → Pages → Source: GitHub Actions.** The index is then served at
   `https://OWNER.github.io/pkgmgr-registry/index.json`, the app's default
   index URL.
3. **Settings → Branches:** protect `main`, require a PR, require the
   `Validate` check, and require review from Code Owners.
4. In every package repo that publishes assets: **Settings → General →
   Releases → Enable release immutability**, so an asset can't be swapped after
   its hash is in the registry.

## Commands

```
pnpm install
pnpm test                                 # validator unit tests
pnpm validate                             # offline checks of every file
node scripts/validate.mjs --base main     # + version bumps and asset hash checks for changed files
node scripts/validate.mjs --verify-all    # download and hash every asset
pnpm build                                # writes dist/index.json
```

The two sample manifests (`nemesis-core`, `example-tool`) have placeholder URLs
and zero hashes. Replace them with real packages before publishing the index.
