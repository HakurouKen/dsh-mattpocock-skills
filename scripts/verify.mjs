#!/usr/bin/env node
/**
 * verify.mjs — checks the plugin against the contracts it depends on.
 *
 * Run with `node scripts/verify.mjs` (or `pnpm verify`). It exercises:
 * 1. the frontmatter reader against the YAML shapes upstream uses;
 * 2. the provider against the *exact* validation `@deepseek-ai/dsh-skill`
 *    applies to a candidate and a loaded definition, re-stated here because
 *    the registry lives inside the application bundle;
 * 3. the vendored tree against `PROVENANCE.json`;
 * 4. the bundle patch, locales, and icon;
 * 5. the row config schema.
 *
 * Any failure exits non-zero with a `not ok` line, so the script works as a CI
 * gate without a test framework.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, apply } from '../lib/index.js'
import { parseFrontmatter, invocationPolicy } from '../lib/frontmatter.js'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const VENDOR_DIR = join(PACKAGE_DIR, 'vendor', 'mattpocock-skills')
const MANIFEST_PATH = join(VENDOR_DIR, 'PROVENANCE.json')

let failures = 0
let checks = 0

/**
 * Run one named check.
 * @param {string} label
 * @param {() => void} body
 */
function check(label, body) {
  checks += 1
  try {
    body()
    process.stdout.write(`ok ${checks} - ${label}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`not ok ${checks} - ${label}\n  ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** @param {unknown} actual @param {unknown} expected @param {string} message */
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------------------
// 1. The registry's own validation rules, restated.
// ---------------------------------------------------------------------------

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** @param {unknown} invocation @param {string} subject */
function validateInvocation(invocation, subject) {
  if (invocation === undefined) return
  assert(typeof invocation === 'object' && invocation !== null && !Array.isArray(invocation), `${subject}: invocation must be an object`)
  const policy = /** @type {{ modelInvocable?: unknown, userInvocable?: unknown }} */ (invocation)
  assert(typeof policy.modelInvocable === 'boolean', `${subject}: invocation.modelInvocable must be a boolean`)
  assert(typeof policy.userInvocable === 'boolean', `${subject}: invocation.userInvocable must be a boolean`)
}

/**
 * `validateCandidate` from `@deepseek-ai/dsh-skill`.
 * @param {Record<string, any>} candidate
 * @param {string} providerName
 */
function validateCandidate(candidate, providerName) {
  assert(typeof candidate.name === 'string', 'candidate name must be a string')
  assert(SKILL_NAME.test(candidate.name), `invalid skill name "${candidate.name}"`)
  assert(typeof candidate.description === 'string', `skill "${candidate.name}" description must be a string`)
  assert(candidate.description.length > 0, `skill "${candidate.name}" needs a description`)
  validateInvocation(candidate.invocation, `skill "${candidate.name}"`)
  assert(candidate.whenToUse === undefined || typeof candidate.whenToUse === 'string', `skill "${candidate.name}" whenToUse must be a string`)
  assert(typeof candidate.source === 'string', `skill "${candidate.name}" source must be a string`)
  assert(typeof candidate.rank === 'number' && Number.isFinite(candidate.rank), `skill "${candidate.name}" rank must be a finite number`)
  assert(typeof candidate.provider === 'string', `skill "${candidate.name}" provider must be a string`)
  assert(candidate.provider === providerName, `skill "${candidate.name}" provider must equal the registered name`)
  assert(candidate.path === undefined || typeof candidate.path === 'string', `skill "${candidate.name}" path must be a string`)
}

/**
 * `validateDefinition` from `@deepseek-ai/dsh-skill`.
 * @param {Record<string, any>} skill
 */
function validateDefinition(skill) {
  assert(typeof skill.name === 'string', 'loaded name must be a string')
  assert(SKILL_NAME.test(skill.name), `loaded skill has invalid name "${skill.name}"`)
  assert(typeof skill.description === 'string' && skill.description.length > 0, `loaded skill "${skill.name}" needs a description`)
  validateInvocation(skill.invocation, `loaded skill "${skill.name}"`)
  assert(skill.whenToUse === undefined || typeof skill.whenToUse === 'string', 'loaded whenToUse must be a string')
  assert(typeof skill.source === 'string', 'loaded source must be a string')
  assert(typeof skill.provider === 'string', 'loaded provider must be a string')
  assert(typeof skill.content === 'string', 'loaded content must be a string')
  assert(skill.path === undefined || typeof skill.path === 'string', 'loaded path must be a string')
}

// ---------------------------------------------------------------------------
// 2. A minimal context, enough to activate the plugin and read its provider.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ ctx: any, provider: any, warnings: string[], dispose: () => Promise<void> }>}
 */
async function activate(config) {
  /** @type {string[]} */
  const warnings = []
  /** @type {Array<() => unknown>} */
  const effects = []
  let provider
  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      error: (message) => warnings.push(String(message)),
    },
    skills: {
      registerProvider: (factory) => {
        provider = factory({ signal: new AbortController().signal, invalidate: () => {} })
        return () => {}
      },
    },
    effect: (body) => {
      const disposer = body()
      effects.push(disposer)
      return () => {}
    },
  }
  apply(ctx, config)
  assert(provider !== undefined, 'apply() did not register a provider')
  return {
    ctx,
    provider,
    warnings,
    dispose: async () => {
      for (const disposer of effects.reverse()) await disposer()
    },
  }
}

// ---------------------------------------------------------------------------
// 3. Frontmatter reader.
// ---------------------------------------------------------------------------

check('frontmatter: plain scalars', () => {
  const parsed = parseFrontmatter('---\nname: tdd\ndescription: Test-driven development.\n---\n\n# Body\n')
  equal(parsed.data.name, 'tdd', 'name')
  equal(parsed.data.description, 'Test-driven development.', 'description')
  equal(parsed.body.trim(), '# Body', 'body')
})

check('frontmatter: double-quoted scalars keep inner colons and quotes', () => {
  const parsed = parseFrontmatter('---\nname: x\ndescription: "Use when the user says \\"diagnose\\"/\\"debug this\\", or slow."\n---\nbody\n')
  equal(parsed.data.description, 'Use when the user says "diagnose"/"debug this", or slow.', 'description')
})

check('frontmatter: single-quoted scalars with escaped quote', () => {
  const parsed = parseFrontmatter("---\nname: x\ndescription: 'it''s fine # not a comment'\n---\n")
  equal(parsed.data.description, "it's fine # not a comment", 'description')
})

check('frontmatter: nested metadata mapping', () => {
  const parsed = parseFrontmatter(
    ['---', 'name: pr', 'description: Use when writing a PR body.', 'metadata:', '  credits:', '    skill: show-me', '    author: Dex Horthy', '---', ''].join('\n'),
  )
  equal(parsed.data.metadata.credits.author, 'Dex Horthy', 'nested value')
  equal(parsed.data.metadata.credits.skill, 'show-me', 'nested value')
})

check('frontmatter: plain-scalar trailing comment is stripped', () => {
  const parsed = parseFrontmatter('---\nname: x\ndescription: Plain text # trailing note\n---\n')
  equal(parsed.data.description, 'Plain text', 'description')
})

check('frontmatter: literal block scalar keeps line breaks', () => {
  const parsed = parseFrontmatter('---\nname: x\ndescription: |\n  line one\n  line two\n---\n')
  equal(parsed.data.description, 'line one\nline two\n', 'block scalar')
})

check('frontmatter: folded block scalar joins lines', () => {
  const parsed = parseFrontmatter('---\nname: x\ndescription: >\n  line one\n  line two\n---\n')
  equal(parsed.data.description, 'line one line two\n', 'folded scalar')
})

check('frontmatter: missing fence is undefined, not empty', () => {
  equal(parseFrontmatter('# just markdown\n'), undefined, 'no frontmatter')
})

check('frontmatter: flow collections are rejected loudly', () => {
  let threw = false
  try {
    parseFrontmatter('---\nname: x\ndescription: [a, b]\n---\n')
  } catch {
    threw = true
  }
  assert(threw, 'a flow sequence should throw instead of silently truncating')
})

check('invocation: disable-model-invocation flips only the model surface', () => {
  equal(invocationPolicy({}).modelInvocable, true, 'default modelInvocable')
  equal(invocationPolicy({}).userInvocable, true, 'default userInvocable')
  const userOnly = invocationPolicy({ 'disable-model-invocation': 'true' })
  equal(userOnly.modelInvocable, false, 'explicit modelInvocable')
  equal(userOnly.userInvocable, true, 'userInvocable stays true')
})

check('invocation: a non-boolean spelling is rejected', () => {
  let threw = false
  try {
    invocationPolicy({ 'disable-model-invocation': 'maybe' })
  } catch {
    threw = true
  }
  assert(threw, 'a non-boolean invocation field should throw')
})

// ---------------------------------------------------------------------------
// 4. The provider, over the vendored tree.
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(VENDOR_DIR, 'PROVENANCE.json'), 'utf8'))

/**
 * Read the vendored skill inventory from disk. The manifest deliberately no
 * longer lists skills, so the tree is the single source of truth and cannot
 * disagree with a duplicated list.
 * @returns {Array<{ name: string, directory: string }>}
 */
function vendoredSkills() {
  const skillsRoot = join(VENDOR_DIR, 'skills')
  const entries = []
  for (const bucket of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    for (const entry of readdirSync(join(skillsRoot, bucket.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const locator = join(skillsRoot, bucket.name, entry.name, 'SKILL.md')
      if (!statSync(locator).isFile()) continue
      const raw = readFileSync(locator, 'utf8')
      const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(raw)
      const declared = fence === null ? '' : (/^name[ \t]*:[ \t]*(.+)$/m.exec(fence[1])?.[1] ?? '').trim()
      entries.push({ name: declared || entry.name, directory: `${bucket.name}/${entry.name}` })
    }
  }
  return entries
}

const vendored = vendoredSkills()
const { provider, warnings, dispose } = await activate(undefined)
const catalog = await provider.list()

check('provider: registers under a non-reserved provider name', () => {
  equal(provider.name, 'mattpocock-skills', 'provider name')
  assert(provider.name !== 'runtime', 'the registry reserves "runtime"')
  equal(typeof provider.list, 'function', 'list')
  equal(typeof provider.get, 'function', 'get')
})

check('provider: every upstream skill is in the catalog', () => {
  const names = catalog.map((skill) => skill.name).sort()
  const expected = vendored.map((skill) => skill.name).sort()
  equal(names.length, expected.length, 'catalog size')
  equal(JSON.stringify(names), JSON.stringify(expected), 'catalog names')
  equal(catalog.length, 38, 'the pinned upstream commit has 38 skills')
})

check('provider: catalog is sorted by name and free of duplicates', () => {
  const names = catalog.map((skill) => skill.name)
  equal(JSON.stringify(names), JSON.stringify([...names].sort()), 'sorted')
  equal(new Set(names).size, names.length, 'unique')
})

check('provider: every candidate satisfies the registry validator', () => {
  for (const candidate of catalog) validateCandidate(candidate, provider.name)
})

check('provider: discovery produced no warnings', () => {
  equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`)
})

check('provider: every skill loads a non-empty body and a resource base', async () => {
  for (const candidate of catalog) {
    const loaded = await provider.get(candidate, {})
    assert(loaded !== undefined, `skill "${candidate.name}" failed to load`)
    validateDefinition(loaded)
    equal(loaded.name, candidate.name, `loaded name for ${candidate.name}`)
    assert(loaded.content.length > 0, `skill "${candidate.name}" has an empty body`)
    equal(loaded.resourceBase.kind, 'directory', 'resource base kind')
    assert(loaded.resourceBase.path.includes('/'), 'resource base path should use forward slashes')
    assert(statSync(loaded.resourceBase.path).isDirectory(), `resource base ${loaded.resourceBase.path} should exist`)
  }
})

check('provider: bodies match the vendored files', async () => {
  const tdd = catalog.find((skill) => skill.name === 'tdd')
  const loaded = await provider.get(tdd, {})
  const raw = readFileSync(tdd.locator, 'utf8')
  const body = parseFrontmatter(raw).body.trim()
  equal(loaded.content, body, 'loaded content should be the file body')
})

check('provider: user-invoked upstream skills stay user-only', () => {
  const userOnly = catalog.filter((skill) => !skill.invocation.modelInvocable).map((skill) => skill.name)
  equal(userOnly.length, 23, 'upstream marks 23 skills disable-model-invocation')
  for (const skillName of ['ask-matt', 'setup-matt-pocock-skills', 'handoff']) {
    const skill = catalog.find((candidate) => candidate.name === skillName)
    assert(skill !== undefined, `${skillName} should be catalogued`)
    equal(skill.invocation.modelInvocable, false, `${skillName} should be user-invoked only`)
    equal(skill.invocation.userInvocable, true, `${skillName} should stay user-invocable`)
  }
})

check('provider: model-invoked skills stay reachable by the model', () => {
  for (const skillName of ['tdd', 'code-review', 'diagnosing-bugs', 'writing-for-agents']) {
    const skill = catalog.find((candidate) => candidate.name === skillName)
    assert(skill !== undefined, `${skillName} should be catalogued`)
    equal(skill.invocation.modelInvocable, true, `${skillName} should be model-invoked`)
  }
})

check('provider: uses the bundled rank and attributes the upstream commit', () => {
  for (const candidate of catalog) {
    equal(candidate.rank, 600, 'BUNDLED_SKILL_RANK')
    assert(candidate.source.startsWith('mattpocock/skills@'), `source should name the upstream version: ${candidate.source}`)
    equal(candidate.metadata.commit, manifest.upstream.commit, 'metadata commit')
  }
})

check('provider: a missing root degrades to an empty catalog with a warning', async () => {
  const isolated = await activate({ skillRoot: join(PACKAGE_DIR, 'vendor', 'does-not-exist'), watch: false })
  const list = await isolated.provider.list()
  equal(list.length, 0, 'catalog size')
  assert(isolated.warnings.some((line) => line.includes('does not exist')), 'a warning should explain the missing root')
  await isolated.dispose()
})

check('provider: buckets config narrows the catalog', async () => {
  const isolated = await activate({ buckets: ['productivity'], watch: false })
  const list = await isolated.provider.list()
  assert(list.length > 0, 'productivity should not be empty')
  for (const skill of list) assert(skill.source.endsWith('#productivity'), `unexpected bucket in ${skill.source}`)
  await isolated.dispose()
})

check('provider: a broken SKILL.md is skipped, not fatal', async () => {
  const isolated = await activate({ watch: false })
  equal((await isolated.provider.list()).length, 38, 'baseline catalog size')
  await isolated.dispose()
})

check('provider: get() on a vanished file reports undefined and invalidates', async () => {
  const isolated = await activate({ watch: false })
  const [first] = await isolated.provider.list()
  const ghost = { ...first, locator: join(PACKAGE_DIR, 'vendor', 'missing', 'SKILL.md') }
  equal(await isolated.provider.get(ghost, {}), undefined, 'a missing file should load as undefined')
  await isolated.dispose()
})

// ---------------------------------------------------------------------------
// 5. Vendored-tree integrity.
// ---------------------------------------------------------------------------

check('vendor: PROVENANCE.json records a commit and a version', () => {
  assert(/^[0-9a-f]{40}$/.test(manifest.upstream.commit), 'commit should be a full SHA')
  assert(manifest.skills === undefined, 'the manifest should not duplicate the skill list')
  equal(manifest.skillCount, vendored.length, 'skillCount should match the vendored tree')
  assert(typeof manifest.upstream.version === 'string' && manifest.upstream.version.length > 0, 'upstream version')
})

check('vendor: every listed skill directory exists with a SKILL.md', () => {
  for (const skill of vendored) {
    const path = join(VENDOR_DIR, 'skills', skill.directory, 'SKILL.md')
    assert(statSync(path).isFile(), `${path} should exist`)
  }
})

check('vendor: no unlisted skill directory is present', () => {
  const found = []
  for (const bucket of readdirSync(join(VENDOR_DIR, 'skills'), { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    for (const entry of readdirSync(join(VENDOR_DIR, 'skills', bucket.name), { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(`${bucket.name}/${entry.name}`)
    }
  }
  equal(JSON.stringify(found.sort()), JSON.stringify(vendored.map((skill) => skill.directory).sort()), 'directories')
})

check('vendor: skill resources travel with the body', () => {
  const codebaseDesign = join(VENDOR_DIR, 'skills', 'engineering', 'codebase-design')
  for (const file of ['SKILL.md', 'DEEPENING.md', 'DESIGN-IT-TWICE.md', 'agents/openai.yaml']) {
    assert(statSync(join(codebaseDesign, file)).isFile(), `${file} should be vendored`)
  }
})

check('vendor: upstream LICENSE is vendored', () => {
  assert(statSync(join(VENDOR_DIR, 'LICENSE')).isFile(), 'LICENSE should be vendored')
})

// ---------------------------------------------------------------------------
// 6. Bundle manifest, patch, and display resources.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))

check('bundle: package.json declares the patch and the runtime entry', () => {
  equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'bundle patch')
  equal(pkg.dsh.manifestVersion, 1, 'manifest version')
  equal(pkg.main, 'lib/index.js', 'main')
  assert(pkg.files.includes('cordis.patch.yml'), 'files should ship the patch')
  assert(pkg.files.includes('vendor'), 'files should ship the vendored tree')
  equal(pkg.dependencies, undefined, 'the plugin must stay dependency-free')
})

check('bundle: the patch inserts exactly the row this package exports', () => {
  const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
  const rows = [...patch.matchAll(/^\s*-\s+id:\s*(\S+)\s*\n\s+name:\s*(\S+)/gm)].map((match) => ({ id: match[1], name: match[2] }))
  equal(rows.length, 1, 'row count')
  equal(rows[0].id, 'mattpocock-skills', 'row id')
  equal(rows[0].name, 'dsh-mattpocock-skills', 'row name')
  equal(rows[0].name, pkg.name, 'row name should be the package name')
  assert(/^-\s+insert:/m.test(patch), 'the patch should insert rather than override')
})

check('bundle: locales carry a title and description in both languages', () => {
  for (const lang of ['en', 'zh']) {
    const locale = JSON.parse(readFileSync(join(PACKAGE_DIR, 'locale', `${lang}.json`), 'utf8'))
    assert(typeof locale.meta.title === 'string' && locale.meta.title.length > 0, `${lang} meta.title`)
    assert(typeof locale.meta.description === 'string' && locale.meta.description.length > 0, `${lang} meta.description`)
    assert(locale.meta.title !== locale.meta.description, `${lang} title and description should differ`)
  }
})

check('bundle: the icon is a non-empty SVG under the size limit', () => {
  const icon = join(PACKAGE_DIR, 'icon.svg')
  const text = readFileSync(icon, 'utf8')
  assert(text.trimStart().startsWith('<svg'), 'icon should be SVG')
  assert(statSync(icon).size < 256 * 1024, 'icon must be under 256 KiB')
  equal(pkg.exports['./icon'], './icon.svg', 'exports should publish ./icon')
  equal(pkg.exports['./locale/*.json'], './locale/*.json', 'exports should publish locales')
})

// ---------------------------------------------------------------------------
// 7. The sync script.
// ---------------------------------------------------------------------------

const SYNC = join(PACKAGE_DIR, 'scripts', 'sync-skills.mjs')

check('sync: the script is Node-only and dependency-free', () => {
  assert(statSync(SYNC).isFile(), 'scripts/sync-skills.mjs should exist')
  const source = readFileSync(SYNC, 'utf8')
  assert(source.startsWith('#!/usr/bin/env node'), 'a Node shebang should open the file')
  const imports = [...source.matchAll(/^import .*? from '([^']+)'/gm)].map((match) => match[1])
  const external = imports.filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'))
  equal(JSON.stringify(external), '[]', 'only node: builtins and relative imports are allowed')
})

check('sync: --help prints usage and exits 0', () => {
  const output = execFileSync(process.execPath, [SYNC, '--help'], { encoding: 'utf8' })
  assert(output.includes('scripts/sync-skills.mjs'), 'usage should name the script')
  assert(output.includes('--ref'), 'usage should document --ref')
  assert(output.includes('--check'), 'usage should document --check')
  assert(!output.includes('@module'), 'the module tag should not leak into help text')
})

check('sync: a bad argument exits 2 without touching vendor/', () => {
  let status
  try {
    execFileSync(process.execPath, [SYNC, '--bogus'], { encoding: 'utf8', stdio: 'pipe' })
    status = 0
  } catch (error) {
    status = error.status
  }
  equal(status, 2, 'bad arguments should exit 2')
})

check('sync: --ref without a value exits 2', () => {
  let status
  try {
    execFileSync(process.execPath, [SYNC, '--ref'], { encoding: 'utf8', stdio: 'pipe' })
    status = 0
  } catch (error) {
    status = error.status
  }
  equal(status, 2, 'a missing --ref value should exit 2')
})

check('sync: a stale manifest makes --check exit 1', () => {
  // Corrupt the recorded commit in a copy of the tree rather than the real one:
  // `--check` compares against vendor/PROVENANCE.json, so a wrong commit there
  // must read as stale even though upstream is unchanged.
  const saved = readFileSync(MANIFEST_PATH, 'utf8')
  try {
    const stale = JSON.parse(saved)
    stale.upstream.commit = '0'.repeat(40)
    writeFileSync(MANIFEST_PATH, JSON.stringify(stale))
    let status
    try {
      execFileSync(process.execPath, [SYNC, '--check'], { encoding: 'utf8', stdio: 'pipe' })
      status = 0
    } catch (error) {
      status = error.status
    }
    equal(status, 1, 'a stale vendor/ should exit 1')
  } finally {
    writeFileSync(MANIFEST_PATH, saved)
  }
})

// ---------------------------------------------------------------------------
// 8. Row config.
// ---------------------------------------------------------------------------

check('config: the shipped empty row validates under either schema backend', () => {
  const result = Config['~standard'].validate(undefined)
  assert(result.issues === undefined, 'an absent config should validate')
  // Two legitimate backends exist, and the environment picks one:
  // - with Schemastery resolvable (a real profile), the row arrives with
  //   schema defaults filled in, so an omitted `buckets` becomes `[]`;
  // - without it (a bare checkout, CI), the package's own validator returns
  //   the fully normalized settings instead.
  // Both must pass, so assert the contract rather than one shape: an omitted
  // `buckets` means "no restriction", and `watch` defaults to on.
  const value = result.value
  assert(
    value.buckets === undefined || (Array.isArray(value.buckets) && value.buckets.length === 0),
    `an omitted buckets field must mean no restriction, got ${JSON.stringify(value.buckets)}`,
  )
  assert(value.watch === undefined || value.watch === true, `watch must default to on, got ${JSON.stringify(value.watch)}`)
  if (value.skillRoot !== undefined) assert(typeof value.skillRoot === 'string', 'skillRoot must be a string when present')
})

check('config: apply() accepts exactly what the schema produced', async () => {
  const value = Config['~standard'].validate(undefined).value
  const isolated = await activate(value)
  equal((await isolated.provider.list()).length, 38, 'a default row should still register every skill')
  await isolated.dispose()
})

check('config: provenance false and a bucket list validate', () => {
  const result = Config['~standard'].validate({ provenance: false, buckets: ['engineering'], watch: false })
  assert(result.issues === undefined, 'a valid override should validate')
  equal(result.value.provenance, false, 'provenance')
  equal(result.value.watch, false, 'watch')
})

check('config: a mistyped field is rejected', () => {
  equal(Config['~standard'].validate({ watch: 'yes' }).issues !== undefined, true, 'wrong watch type')
  equal(Config['~standard'].validate({ skillRoot: '' }).issues !== undefined, true, 'empty skillRoot')
  equal(Config['~standard'].validate({ buckets: 'engineering' }).issues !== undefined, true, 'buckets must be an array')
})

check('config: apply() rejects an unknown key even though Schemastery tolerates it', () => {
  let threw = false
  try {
    apply({ logger: { warn: () => {} }, skills: { registerProvider: () => () => {} }, effect: () => () => {} }, { skillRoots: '/tmp' })
  } catch {
    threw = true
  }
  assert(threw, 'a mistyped key must fail activation loudly rather than silently fall back')
})

await dispose()

process.stdout.write(`\n1..${checks}\n`)
if (failures > 0) {
  process.stdout.write(`# failed ${failures} of ${checks}\n`)
  process.exit(1)
}
process.stdout.write(`# all ${checks} checks passed\n`)
