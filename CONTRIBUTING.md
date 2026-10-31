# Publishing a package

A package is a GitHub Release in your own repo plus a manifest in this registry
that points at it. A Nemesis stick holds one package at a time.

- **A tool package** is a `.zip` and its `NEMESIS.data`, both attached to the
  same release. The app writes them as `packages/<id>.zip` and `NEMESIS.data`.
  Or it is just a `.zip` that holds the stick layout, `NEMESIS.data` included,
  which the app unpacks into the drive root (see
  [Zip-only releases](#zip-only-releases)).
- **The Core package** is a single `.tar`. The app writes it to the drive root
  under its release file name, and it is installed onto a new device before any
  tool.

## 1. Publish the release

1. In your package repo, turn on **Settings → General → Releases → Enable
   release immutability**. Once published, the tag and assets can never change,
   so the hashes in the registry stay valid forever.
2. Create a release with a new tag (for example `v1.4.0`) and attach:
   - the package, named after its id: `my.tool.zip`
   - its data file, named `NEMESIS.data` (tool packages only, unless the zip
     carries it)
3. Publish it, then copy each asset's download link. They look like
   `https://github.com/<you>/<repo>/releases/download/v1.4.0/my.tool.zip`.

## 2. Get the hashes and sizes

Download the assets you just uploaded (not your local copies, in case the upload
changed them) and run this for each file:

| OS                   | SHA-256                                                       | Size in bytes                   |
| -------------------- | ------------------------------------------------------------- | ------------------------------- |
| Windows (PowerShell) | `(Get-FileHash my.tool.zip -Algorithm SHA256).Hash.ToLower()` | `(Get-Item my.tool.zip).Length` |
| macOS                | `shasum -a 256 my.tool.zip`                                   | `stat -f %z my.tool.zip`        |
| Linux                | `sha256sum my.tool.zip`                                       | `stat -c %s my.tool.zip`        |

## 3. Add or update the manifest

Create or edit `packages/<id>.json`. The file name must be the id.

```json
{
  "$schema": "../schema/package.schema.json",
  "id": "my.tool",
  "name": "My Tool",
  "description": "One line shown on the card",
  "version": "1.4.0",
  "format": "zip",
  "url": "https://github.com/<you>/<repo>/releases/download/v1.4.0/my.tool.zip",
  "sha256": "<64 lowercase hex chars>",
  "size": 48213345,
  "data": {
    "url": "https://github.com/<you>/<repo>/releases/download/v1.4.0/NEMESIS.data",
    "sha256": "<64 lowercase hex chars>",
    "size": 4096
  },
  "extract": false,
  "slot": "packages",
  "profiles": ["nemesis"],
  "requires": ["nemesis-core"],
  "homepage": "https://github.com/<you>/<repo>"
}
```

| Field      | Meaning                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | Lowercase letters and digits, separated by single `.` or `-`. Becomes the file name on the drive (`packages/my.tool.zip`). Never change it after first release. |
| `version`  | Semantic version. Must be higher than the one on `main` for every change.                                                                                       |
| `format`   | `zip`, or `tar` for the Core package.                                                                                                                           |
| `data`     | The `NEMESIS.data` asset from the **same release**. Required for tool packages (slot `packages`) unless the zip carries it; not allowed for Core.               |
| `extract`  | Whether the app unpacks the zip by default. Users can override it, except for a zip that carries `NEMESIS.data`. A tar is never unpacked.                       |
| `slot`     | Where the file goes, by name. For Nemesis: `packages` for tools, `core` for Core.                                                                               |
| `profiles` | The devices this package works on.                                                                                                                              |
| `requires` | Packages that must already be installed on the **device** (not the stick), usually `nemesis-core`. Shown to users; the app never installs them automatically.   |

For the Core package, leave out `data` and `requires` and set `"core": true`,
`"format": "tar"` and `"slot": "core"`.

### Zip-only releases

A zip can carry the whole stick layout itself, `NEMESIS.data` included:

```text
my.tool.zip
  NEMESIS.data
  packages/my.tool.inner.zip
  mytool/install.sh
```

Leave out `data` and set `"extract": true`. The app always unpacks such a zip
into the drive root, so `NEMESIS.data` lands where the device reads it.
`NEMESIS.data` must be at the top of the zip, not inside a folder: zip the
folder's contents, not the folder itself. The validator opens the zip to check
this, and also rejects a release that ships `NEMESIS.data` both inside the zip
and as a `data` asset.

## 4. Check locally, then open a PR

```shell
pnpm install
node scripts/validate.mjs --base main
```

This runs everything CI runs: the schema, id/file-name match, slot and data-file
checks, the version bump, and a real download of every asset to confirm `sha256`
and `size` (and, for a zip, where its `NEMESIS.data` comes from). Open the PR
when it prints `OK`. A Code Owner reviews and merges it, and the new index goes
live on Pages within one CI run. The app picks it up the next time it refreshes.

## Later releases

Once your package is in the registry, its new releases need no PR. Every night a
GitHub Action takes your repo's newest release, checks it as CI checks a PR, and
updates `version`, `url`, `sha256` and `size` (and `data`) on `main`. Other
fields stay as they are; change those with a PR.

It takes a release that:

- is published and not marked as a pre-release
- has a tag that reads as a version higher than the registry's: `v1.5.0`,
  `1.5.0` and `v1.5` (read as `1.5.0`) all work, `v1.5.0-beta` does not
- has exactly one asset named like the one the registry has now, give or take
  its version numbers and letter case: after `my.tool-1.4.0-usb.zip` it takes
  `my.tool-1.5-usb.zip` or `My.Tool-1.5.0-USB.zip`, but not `my.tool-1.5.0.zip`
- has a `NEMESIS.data` asset too, if the package has a `data` file
- passes every check in step 4

A release that doesn't fit is left out, and the nightly run says why. If your
tags or asset names work differently, a maintainer adds a rule for your package
to [`autoupdate.json`](autoupdate.json):

```json
{
  "gen5-smarttube": {
    "tag": "^v(\\d+)\\.(\\d+)-gen5w\\.(\\d+)$",
    "version": "$1.$2.$3"
  }
}
```

| Key       | Meaning                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `skip`    | `true` to never update the package by itself.                                                                                           |
| `repo`    | `owner/name` to take releases from, when the repo in `url` has moved.                                                                   |
| `asset`   | A regex the whole asset name must match, in place of the name it has now. Case is ignored.                                              |
| `tag`     | A regex a release's tag must match; other releases are ignored. This picks one package's releases out of a repo that publishes several. |
| `version` | The version, made from the `tag` regex's groups (`$1`, `$2`, …), for tags that don't read as one. Above, `v32.68-gen5w.5` is `32.68.5`. |

## Changing a profile

Profiles describe the folder layout a device expects. Bump `version` on every
change. The app compares it with the version recorded on each drive and offers
to migrate. Changes that rename or remove a slot need every package using that
slot updated in the same PR.
