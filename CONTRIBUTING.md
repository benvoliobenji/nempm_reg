# Publishing a package

A package is a `.zip` (or, for the core Nemesis package only, a `.tar`) attached
to a GitHub Release in your own repo, plus a manifest in this registry that
points at it.

## 1. Publish the release

1. In your package repo, turn on **Settings → General → Releases → Enable
   release immutability**. Once published, the tag and assets can never change,
   so the hash in the registry stays valid forever.
2. Create a release with a new tag (for example `v1.4.0`) and attach the file.
   Name it after the package id: `my-tool.zip`.
3. Publish it, then copy the asset's download link. It looks like
   `https://github.com/<you>/<repo>/releases/download/v1.4.0/my-tool.zip`.

## 2. Get the hash and size

Download the asset you just uploaded (not your local copy, in case the upload
changed it) and run:

| OS                   | SHA-256                                                       | Size in bytes                   |
| -------------------- | ------------------------------------------------------------- | ------------------------------- |
| Windows (PowerShell) | `(Get-FileHash my-tool.zip -Algorithm SHA256).Hash.ToLower()` | `(Get-Item my-tool.zip).Length` |
| macOS                | `shasum -a 256 my-tool.zip`                                   | `stat -f %z my-tool.zip`        |
| Linux                | `sha256sum my-tool.zip`                                       | `stat -c %s my-tool.zip`        |

## 3. Add or update the manifest

Create or edit `packages/<id>.json`. The file name must be the id.

```json
{
  "$schema": "../schema/package.schema.json",
  "id": "my-tool",
  "name": "My Tool",
  "description": "One line shown on the card",
  "version": "1.4.0",
  "format": "zip",
  "url": "https://github.com/<you>/<repo>/releases/download/v1.4.0/my-tool.zip",
  "sha256": "<64 lowercase hex chars>",
  "size": 48213345,
  "extract": false,
  "slot": "packages",
  "profiles": ["nemesis"],
  "deps": ["nemesis-core"],
  "homepage": "https://github.com/<you>/<repo>"
}
```

| Field      | Meaning                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | Lowercase letters, digits and `-`. Becomes the file name on the drive (`packages/my-tool.zip`). Never change it after the first release. |
| `version`  | Semantic version. Must be higher than the one on `main` for every change.                                                                |
| `format`   | `zip`, or `tar` for the core package.                                                                                                    |
| `extract`  | Whether the app unpacks the zip by default. Users can override it. A tar is never unpacked.                                              |
| `slot`     | Where the file goes, by name. For Nemesis: `packages` for tools, `core` for the core.                                                    |
| `profiles` | The devices this package works on.                                                                                                       |
| `deps`     | Package ids that must be installed first. Most tools depend on `nemesis-core`.                                                           |

## 4. Check locally, then open a PR

```shell
pnpm install
node scripts/validate.mjs --base main
```

This runs everything CI runs: the schema, id/file-name match, slot and
dependency checks, the version bump, and a real download of your asset to
confirm `sha256` and `size`. Open the PR when it prints `OK`. A Code Owner
reviews and merges it, and the new index goes live on Pages within one CI run.
The app picks it up the next time it refreshes.

## Changing a profile

Profiles describe the folder layout a device expects. Bump `version` on every
change. The app compares it with the version recorded on each drive and offers
to migrate. Changes that rename or remove a slot need every package using that
slot updated in the same PR.
