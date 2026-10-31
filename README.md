# nempm registry

The database behind the Nemesis Package Manager (nempm) app. It is a plain Git
repo of JSON files, in the spirit of a Scoop bucket:

```text
packages/<id>.json          one manifest per package
profiles/<device>.json      the USB layout each target device expects
schema/*.schema.json        JSON Schema for profiles and packages
autoupdate.json             rules for the nightly update of packages
scripts/                    validation, build and update scripts for the registry
test/                       unit tests for the scripts
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
  .nempm/manifest.json    written by the app: what is installed, and where
```

`NEMESIS.data` belongs to the package and is written and removed together with
it. It comes one of two ways:

- as an asset of the same GitHub release as the zip (the manifest's `data`
  field), or
- inside the zip itself, at its top level, for a zip that already holds the
  whole stick layout. Such a package sets `"extract": true` and has no `data`;
  the app always unpacks it into the drive root, which puts `NEMESIS.data` in
  place.

A Core stick, used to set up a new device before any tool:

```text
<drive root>/
  ota_package.tar         the Core .tar, under its release file name, never unpacked
  .nempm/manifest.json
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
pnpm test                                 # unit tests
pnpm validate                             # offline checks of every file
node scripts/validate.mjs --base main     # + version bumps and asset hash checks for changed files
node scripts/validate.mjs --verify-all    # download and hash every asset
node scripts/autoupdate.mjs --dry-run     # what the nightly update would change
pnpm build                                # writes dist/index.json
```

The `example-tool` manifest is a sample with placeholder URLs and zero hashes.
Replace it with real packages before publishing the index.
