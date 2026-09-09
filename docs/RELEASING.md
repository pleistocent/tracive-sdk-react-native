# Releasing the React Native SDK

Anyone with **write** access to this repository can cut a complete release: the gates, npm, the tag
and the GitHub release all come out of one workflow dispatch.

One thing has to be set up first and it is not done yet. Read
[Before the first release](#before-the-first-release).

## Cut a release

1. **Move the entries out of `## [Unreleased]`** in `CHANGELOG.md` into a `## [0.1.1]` section,
   bump `version` in `package.json` to match, and merge that to `main`. The changelog section
   becomes the GitHub release body.
2. **Actions → Release → Run workflow**, with `version` = `0.1.1` (no `v` prefix).

| Stage       | What it does                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preflight` | Version format, `package.json` agreement, changelog section, not already released, `NPM_TOKEN` present                                           |
| `verify`    | The full `ci.yml` gate set on Node 20.19 and 22 — hygiene, fixture, typecheck, lint, tests with coverage, build, `publint`/`attw`, runtime audit |
| `publish`   | `npm publish --access public`, an anonymous installability check, then tag `v0.1.1` and the GitHub release                                       |

**Rehearse with `dry_run`** — same checks, packs the tarball and prints its contents, publishes
nothing and tags nothing. It is the only mode that works before the setup below is done.

## The restricted-package trap, and what now catches it

`CONTRIBUTING.md` has said from the start that the first publish should be a human action, because
a scoped package publishes as **restricted** by default and `publishConfig.access` failing silently
produces a private package. That is a real failure and it is quiet: `npm publish` succeeds, the
version appears on the registry, everything looks released — and `npm install` from outside the org
returns 404.

The workflow answers it in two places rather than trusting one:

- `npm publish --access public`, passed explicitly even though `publishConfig.access` already says
  it. Saying it twice costs nothing.
- **An anonymous fetch of the published version afterwards.** No credentials, retried for 75
  seconds. A restricted package answers 404 to that request — the same 404 a partner would get — so
  the check fails on exactly the condition it exists to find, rather than passing because the
  publish step returned 0.

If it ever does fire, the fix is `npm access public @tracive/sdk-react-native`.

## What the workflow will refuse to do

- **Release a version that is not `x.y.z`**, or one where `package.json` disagrees with the version
  you typed. npm publishes what `package.json` says; a mismatch would put one version on the
  registry under another version's tag.
- **Release a version with no changelog section.**
- **Release a version that already has a tag, or is already on npm.** A published version can be
  deprecated but not replaced; unpublish exists only for 72 hours and removes the whole version.
- **Run without `NPM_TOKEN`.**

## Before the first release

### 1. The `@tracive` scope has to exist on npm

`@tracive/sdk-react-native` is not on the registry, and neither is the scope. Creating an npm
organisation is a manual, one-off action — a workflow cannot do it, and it is the part of
"first publish is a human action" that stays human.

### 2. Add `NPM_TOKEN`

Settings → Secrets and variables → Actions. Needs repository **admin** rights.

| Secret      | What it is                                                              | Where it comes from                                       |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `NPM_TOKEN` | A **granular access token** with read-and-write on the `@tracive` scope | npmjs.com → Access Tokens → Generate New Token → Granular |

Use a granular token scoped to `@tracive`, not a classic automation token: a classic token can
publish anything the account can, which is far more than this workflow needs.

**Once the package exists, consider replacing the token with trusted publishing.** npm supports
OIDC from GitHub Actions, which removes the long-lived credential entirely — but like everything
else on the package's settings page it can only be configured for a package that already exists,
so it is an upgrade for later rather than a way to start.

## Provenance

Not enabled. `--provenance` requires a public repository, and this one is private; turning it on
would fail the publish rather than add anything. When the repository goes public it is one flag
plus `id-token: write` on the publish job.

## When something goes half-wrong

**Publish succeeded, tagging failed.** The package is on npm and cannot be replaced. Re-running is
blocked, correctly, by the "already on npm" check. Push the tag and cut the release by hand:

```bash
git tag -a v0.1.1 -m v0.1.1 <the SHA the run used>
git push origin v0.1.1
gh release create v0.1.1 --title v0.1.1 --notes-file <the changelog section> --verify-tag
```

**The gates failed.** Nothing was published and nothing was tagged. Fix and dispatch again with the
same version.

**A broken version reached npm.** Within 72 hours `npm unpublish @tracive/sdk-react-native@0.1.1`
removes it, and doing so burns the version number for good. After that,
`npm deprecate @tracive/sdk-react-native@0.1.1 "<why>"` and ship a patch.
