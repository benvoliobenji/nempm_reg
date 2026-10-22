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

[`profiles/nemesis.json`](profiles/nemesis.json) describes the drive layout:

```text
<drive root>/
  NEMESIS.data            the core data file required by NEMESIS to function per package
  packages/
    <tool>.zip            the tool package
  .pkgmgr/manifest.json   written by the app: what is installed, and where
```

A zip package can optionally be unpacked to `packages/<tool>/` instead, if a
user switches **Extract** on for that install.

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

The two sample manifests (`nemesis-core`, `example-tool`) have placeholder URLs
and zero hashes. Replace them with real packages before publishing the index.
