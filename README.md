# nempm registry

The database behind the Nemesis Package Manager (nempm) app. It is a plain Git
repo of JSON files, in the spirit of a Scoop bucket:

```text
packages/<id>.json          one manifest per package
profiles/<device>.json      the USB layout each target device expects
schema/*.schema.json        JSON Schema for profiles and packages
scripts/                    validation and build scripts for the registry
test/                       unit tests for the validator
```

To add or update a package, see [CONTRIBUTING.md](CONTRIBUTING.md).

## The Nemesis profile

[`profiles/nemesis.json`](profiles/nemesis.json) describes the drive layout. A
stick carries **one package at a time**; installing another replaces it once the
user confirms.

A tool package stick:

```text
<drive root>/
  NEMESIS.data            the data file the Core system reads to install this package
  packages/
    <tool>.zip            the tool package
  .pkgmgr/manifest.json   written by the app: what is installed, and where
```

`NEMESIS.data` belongs to the package: it is published as an asset of the same
GitHub release as the zip (the manifest's `data` field), written and removed
together with it.

A Core stick, used to set up a new device before any tool:

```text
<drive root>/
  ota_package.tar         the Core .tar, under its release file name, never unpacked
  .pkgmgr/manifest.json
```

A zip package can be unpacked instead (its `extract` default, or the user's
**Unpack** switch): its contents go straight into the drive root, so a zip that
holds `packages/<x>.zip` and other folders lays them out exactly as packaged,
next to `NEMESIS.data`. Swapping to another package removes every file it wrote
and any folder left empty, `packages/` included.

The profile's `version` must be bumped whenever the layout changes; the app sees
the new version and offers to migrate drives that were written with the old one.

## Commands

```shell
pnpm install
pnpm test                                 # validator unit tests
pnpm validate                             # offline checks of every file
node scripts/validate.mjs --base main     # + version bumps and asset hash checks for changed files
node scripts/validate.mjs --verify-all    # download and hash every asset
pnpm build                                # writes dist/index.json
```

The `example-tool` manifest is a sample with placeholder URLs and zero hashes.
Replace it with real packages before publishing the index.
