# dsh-plugin-mattpocock-skills

Turns [mattpocock/skills][upstream] into a dsh plugin.

**English** | [简体中文](README-zh.md)

## What this is

| | |
|---|---|
| Upstream | [github.com/mattpocock/skills][upstream] (MIT), synced daily |
| Contents | 38 skills, one directory each: `skills/<name>/SKILL.md` plus its own resources |
| Adds | one Host row registering a `ctx.skills` provider — writes nothing to any skills root |
| DSH | `>=0.2.0-rc.1 <0.3.0-0` |
| Runtime deps | none |

Upstream's `engineering` / `productivity` / `misc` / `in-progress` buckets are
flattened away: nothing consumes them, and skill names are unique across them.
Skills carry rank 600, so a project-local skill of the same name still wins. The
23 skills upstream marks `disable-model-invocation` stay reachable only by
`/name`, never by the model. Only `skills/` and upstream's `LICENSE` are
vendored — not their docs, CI, or plugin metadata.

## Who needs this

**You already installed Matt Pocock's skills as a Codex plugin, and you do not
want a second copy in `~/.agents/skills` just so DSH can see them.**

Codex's plugin route keeps the skills inside Codex's own storage, which a
Harness session never reads. Harness only discovers skills under
`<project>/.dsh/skills`, `<project>/.agents/skills`, `~/.dsh/skills`, and
`~/.agents/skills`. Copying the skills into one of those works, but it leaves
the same 38 skills in two places with two update paths that drift apart.

This bundle is the alternative: DSH gets the skills without a second copy.

It also fits you if you keep agent config global and project-agnostic, or want
the synced content pinned and auditable.

**Not needed** if the skills already sit in `~/.agents/skills` or
`<project>/.agents/skills`: those roots outrank this bundle (500/200 versus
600), so a local copy shadows it and the two will disagree. Pick one location.

## Usage

### Install

From npm:

```bash
dsh plugin --profile <profile> add dsh-plugin-mattpocock-skills
```

From a checkout:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin-mattpocock-skills
```

Then enable the bundle once — Web UI **Plugins → Bundles**, or add it to
`dsh.profile.bundles` — and restart the Harness, since a new module generation
only loads on boot. All 38 skills then appear in the session catalog, reachable
with the `skill` tool or as `/name` commands.

```bash
dsh plugin --profile <profile> remove dsh-plugin-mattpocock-skills   # uninstall
```

### Update from upstream

```bash
node scripts/sync-skills.mjs                # track the default branch
node scripts/sync-skills.mjs --ref v1.3.2   # pin a tag, branch, or commit
node scripts/sync-skills.mjs --check        # exit 1 when skills/ is stale
```

A zero-dependency Node script: it clones upstream into a temp directory, stages
the skill directories, and replaces `skills/` only once the copy is complete.
Provenance — repository, commit, identity, skill count — lands in
`skills/PROVENANCE.json`. The identity follows upstream: the release tag when
that commit carries one, otherwise the commit SHA, never a version we manage.

A running Harness picks up a re-sync without a restart; only `lib/` changes need
one.

`.github/workflows/sync-skills.yml` runs the same sync at **00:00 UTC**, commits
only `skills/`, and does so only after all 44 checks pass — a day with no
upstream change commits nothing.

### Verify

```bash
node scripts/verify.mjs
```

44 checks over the frontmatter reader, the registry's validators, every skill's
catalog entry and loaded body, the bundle metadata, and the sync script's exit
codes.

### Release

Published to npm on a policy measured against the last `v*` tag:

| Change since the last tag | Version |
|---|---|
| skill content | **patch** |
| skills added or removed | **minor** |
| plugin structure (`cordis.patch.yml`, `lib/`, manifest shape) | **major** |

CI publishes patch and minor automatically after a sync. A **major is never
automatic** — it needs a manual run of the Release workflow, because a
structural change can invalidate installed compositions.

Publishing uses [trusted publishing][trusted]: the workflow exchanges its
GitHub OIDC identity for a short-lived npm credential and attaches a provenance
statement, so **no npm token is stored in this repository**. One-time setup on
npmjs.com — package → Settings → Trusted Publisher → GitHub Actions with owner
`HakurouKen`, repository `dsh-plugin-mattpocock-skills`, workflow `release.yml`,
and publish permission enabled.

A brand-new package cannot use a trust relationship, so the **first publish is
manual**: `npm login && npm publish --access public`, then configure the trust
relationship and run the workflow once with `mode: publish-current` to record
the `v0.1.0` tag.

### Configuration

The row needs no `config`. Optional fields: `skillRoot` (default: the vendored
`skills/`), `provenance` (default: its `PROVENANCE.json`; `false` omits it), and
`watch` (default: `true`). Unknown keys fail activation loudly.

---

Plugin code is MIT. The vendored skills are MIT, © Matt Pocock, with the
upstream licence at `skills/LICENSE`; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[upstream]: https://github.com/mattpocock/skills
[trusted]: https://docs.npmjs.com/trusted-publishers
