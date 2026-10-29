# Third-party notices

## Matt Pocock's agent skills

This package vendors the skill content of
[github.com/mattpocock/skills](https://github.com/mattpocock/skills) into
`skills/`. That content is not original to this package.

- **Copyright** © Matt Pocock and the repository's contributors
- **Licence** MIT — the full text is vendored at
  `skills/LICENSE`
- **Upstream version** recorded in `skills/PROVENANCE.json`,
  including the exact commit each skill body came from
- **Not affiliated** with Matt Pocock or aihero.dev; this is an independent
  packaging of the published skills for DeepSeek Harness

Two upstream resources carry their own attribution, preserved verbatim in their
skill directories:

- `skills/engineering/pr/SKILL.md` credits the `show-me` skill by Dex Horthy
  (Humanlayer) in its frontmatter `metadata.credits`
- `skills/in-progress/setup-ts-deep-modules/` ships a
  `dependency-cruiser.config.cjs` derived from that project's documentation

To re-vendor the content, run `scripts/sync-skills.mjs`. To redistribute, retain
the upstream `LICENSE` and `PROVENANCE.json` — the sync script copies both
automatically.

## Plugin code

Everything outside `vendor/` is original to this package and released under the
MIT licence in `LICENSE`.
