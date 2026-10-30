/**
 * `dsh-plugin-mattpocock-skills` — a DeepSeek Harness skill provider over a vendored
 * copy of github.com/mattpocock/skills.
 *
 * The package ships the upstream tree (see `scripts/sync-skills.mjs`) and this
 * module registers one `ctx.skills` provider over it. Nothing is written to
 * `.dsh/skills`, `.agents/skills`, or `~/.dsh/skills`, so the plugin neither
 * collides with a user's own local skills nor depends on where a project sits.
 *
 * Design notes:
 * - The catalog is built at activation and rebuilt when a watched `SKILL.md`
 *   or skill directory changes. A skill body is re-read on every load, so an
 *   edited body needs no restart; `invalidate()` on the registration control
 *   drops the registry's cached catalog, which has no TTL of its own.
 * - Frontmatter is parsed by `./frontmatter.js`, which understands the YAML
 *   subset the upstream repository uses and throws on anything else. A skill
 *   that fails to parse is skipped with a warning and never fails activation.
 * - Discovery is one level deep (`skills/<name>/SKILL.md`), because the
 *   vendored tree is flat; a single-file `skills/<name>.md` is also accepted.
 *
 * @module dsh-plugin-mattpocock-skills
 */

import { existsSync, readFileSync, readdirSync, statSync, unwatchFile, watch, watchFile } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

import { normalizeConfig } from './config.js'
import { invocationPolicy, parseFrontmatter } from './frontmatter.js'

/** Registry rank for packaged skill providers and bundled roots. */
const BUNDLED_SKILL_RANK = 600

/** Cordis plugin identity. */
export const name = 'mattpocock-skills'

/** Services this plugin needs before it activates. */
export const inject = ['skills']

/** Row config schema; also re-exported so a test can validate a proposed row. */
export { Config } from './config.js'

/** Provider name registered on `ctx.skills`; unique within one scope layer. */
const PROVIDER_NAME = 'mattpocock-skills'

/**
 * Register the provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying `skills`.
 * @param {unknown} [config] - optional row config; see {@link normalizeConfig}.
 * @returns {void}
 * @throws when the row config is not a valid mapping, so activation reports it.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const provenance = settings.provenance === false ? undefined : readProvenance(settings.provenance)
  const warn = (message) => ctx.logger.warn(`${name}: ${message}`)

  /** @type {SkillRecord[]} */
  let catalog = []
  let dirty = !settings.watch

  /** @type {import('@deepseek-ai/dsh-skill').SkillRegistrationControl | undefined} */
  let control

  /**
   * Rebuild the catalog. A read failure keeps the previous catalog so a
   * transient error never looks like "every skill was deleted".
   * @param {string} reason
   * @returns {SkillRecord[]}
   */
  const refresh = (reason) => {
    try {
      catalog = scanSkills(settings, provenance, warn)
      dirty = false
      return catalog
    } catch (error) {
      warn(`discovery failed (${reason}): ${error instanceof Error ? error.message : String(error)}`)
      return catalog
    }
  }

  /**
   * Current catalog, rescanned when a watcher marked it stale.
   * @returns {SkillRecord[]}
   */
  const current = () => (dirty ? refresh('list') : catalog)

  refresh('startup')

  ctx.skills.registerProvider((registration) => {
    control = registration
    return {
      name: PROVIDER_NAME,
      /**
       * Report the catalog.
       * @returns {Promise<SkillRecord[]>}
       */
      list() {
        return Promise.resolve(current())
      },
      /**
       * Load one skill body, re-reading the file so an edited body needs no
       * catalog refresh.
       * @param {SkillRecord} candidate
       * @param {{ signal?: AbortSignal }} options
       * @returns {Promise<LoadedSkill | undefined>}
       */
      async get(candidate, options) {
        let raw
        try {
          raw = await readFile(candidate.locator, { encoding: 'utf8', signal: options.signal })
        } catch (error) {
          if (options.signal?.aborted === true) throw error
          // The file vanished between listing and loading. Drop it from the
          // catalog and report an unknown skill instead of throwing inside the
          // model's tool call.
          warn(`skill "${candidate.name}" could not be read: ${error instanceof Error ? error.message : String(error)}`)
          dirty = true
          control?.invalidate()
          return undefined
        }
        const parsed = parseSkillFile(raw, candidate.locator, warn)
        if (parsed === undefined) {
          dirty = true
          control?.invalidate()
          return undefined
        }
        return {
          name: parsed.name,
          description: parsed.description,
          ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
          invocation: parsed.invocation,
          ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
          source: candidate.source,
          provider: PROVIDER_NAME,
          resourceBase: { kind: 'directory', path: toPortablePath(candidate.resourceDir) },
          path: candidate.locator,
          content: parsed.content,
        }
      },
    }
  })

  if (!settings.watch) return

  const closes = watchSkillRoot(settings.skillRoot, () => {
    dirty = true
    control?.invalidate()
  })
  ctx.effect(() => () => {
    for (const close of closes) close()
  })
}

/**
 * Read the provenance manifest written by `scripts/sync-skills.mjs`.
 * @param {string} path
 * @returns {Provenance | undefined}
 */
function readProvenance(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const upstream = parsed?.upstream
    if (typeof upstream !== 'object' || upstream === null) return undefined
    return {
      repository: typeof upstream.repository === 'string' ? upstream.repository : undefined,
      commit: typeof upstream.commit === 'string' ? upstream.commit : undefined,
      version: typeof upstream.version === 'string' ? upstream.version : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Enumerate every skill under the configured root.
 * @param {import('./config.js').Settings} settings
 * @param {Provenance | undefined} provenance
 * @param {(message: string) => void} warn
 * @returns {SkillRecord[]}
 */
function scanSkills(settings, provenance, warn) {
  const root = settings.skillRoot
  if (!existsSync(root)) {
    warn(`skill root ${root} does not exist; run scripts/sync-skills.mjs in the plugin directory`)
    return []
  }
  // The manifest carries one identity field: an upstream tag when the synced
  // commit carries one, otherwise that commit's short SHA.
  const source =
    provenance?.version === undefined ? 'mattpocock/skills' : `mattpocock/skills@${provenance.version}`
  const metadata =
    provenance === undefined
      ? undefined
      : {
          upstream: provenance.repository ?? 'https://github.com/mattpocock/skills',
          ...(provenance.commit === undefined ? {} : { commit: provenance.commit }),
          ...(provenance.version === undefined ? {} : { version: provenance.version }),
        }

  /** @type {SkillRecord[]} */
  const records = []
  /** @type {Map<string, string>} */
  const claimed = new Map()
  // One level: `<root>/<name>/SKILL.md`. The vendored tree is flat, and a user
  // pointing `skillRoot` at their own directory gets the same simple rule.
  for (const entry of listDirectories(root)) {
    const resourceDir = join(root, entry)
    const locator = join(resourceDir, 'SKILL.md')
    if (!existsSync(locator)) continue
    add(records, claimed, readCandidate(locator, resourceDir, source, metadata, warn), warn)
  }
  // A flat single-file skill `<root>/<name>.md` stays supported.
  for (const entry of listFiles(root)) {
    if (!entry.endsWith('.md')) continue
    const locator = join(root, entry)
    add(records, claimed, readCandidate(locator, root, source, metadata, warn), warn)
  }
  return records.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * Append a parsed record, warning when another directory already claimed the
 * name so the catalog keeps a deterministic winner.
 * @param {SkillRecord[]} records
 * @param {Map<string, string>} claimed
 * @param {SkillRecord | undefined} record
 * @param {(message: string) => void} warn
 */
function add(records, claimed, record, warn) {
  if (record === undefined) return
  const existing = claimed.get(record.name)
  if (existing !== undefined) {
    warn(`skill "${record.name}" in ${record.locator} ignored because ${existing} already declared it`)
    return
  }
  claimed.set(record.name, record.locator)
  records.push(record)
}

/**
 * Parse one candidate file into a catalog record, warning and returning
 * `undefined` when it is not a usable skill.
 * @param {string} locator
 * @param {string} resourceDir
 * @param {string} source
 * @param {Record<string, string> | undefined} metadata
 * @param {(message: string) => void} warn
 * @returns {SkillRecord | undefined}
 */
function readCandidate(locator, resourceDir, source, metadata, warn) {
  let raw
  try {
    raw = readFileSync(locator, 'utf8')
  } catch (error) {
    warn(`skill file ${locator} ignored: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const parsed = parseSkillFile(raw, locator, warn)
  if (parsed === undefined) return undefined
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    invocation: parsed.invocation,
    ...(metadata === undefined ? {} : { metadata }),
    source,
    provider: PROVIDER_NAME,
    rank: BUNDLED_SKILL_RANK,
    locator,
    resourceDir,
    path: locator,
  }
}

/**
 * Parse a skill file into the fields the registry validates.
 * @param {string} raw - complete file text.
 * @param {string} locator - path used in diagnostics.
 * @param {(message: string) => void} warn
 * @returns {ParsedSkill | undefined}
 */
function parseSkillFile(raw, locator, warn) {
  let frontmatter
  try {
    frontmatter = parseFrontmatter(raw)
  } catch (error) {
    warn(`skill file ${locator} ignored: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (frontmatter === undefined) {
    warn(`skill file ${locator} ignored: missing YAML frontmatter`)
    return undefined
  }
  const { name: skillName, description, whenToUse } = frontmatter.data
  if (typeof skillName !== 'string' || skillName.length === 0) {
    warn(`skill file ${locator} ignored: frontmatter requires a string "name"`)
    return undefined
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    warn(`skill file ${locator} ignored: invalid skill name "${skillName}"`)
    return undefined
  }
  if (typeof description !== 'string' || description.length === 0) {
    warn(`skill file ${locator} ignored: frontmatter requires a string "description"`)
    return undefined
  }
  if (whenToUse !== undefined && whenToUse !== null && typeof whenToUse !== 'string') {
    warn(`skill file ${locator} ignored: "whenToUse" must be a string`)
    return undefined
  }
  let invocation
  try {
    invocation = invocationPolicy(frontmatter.data)
  } catch (error) {
    warn(`skill file ${locator} ignored: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  return {
    name: skillName,
    description,
    whenToUse: typeof whenToUse === 'string' ? whenToUse : undefined,
    invocation,
    content: frontmatter.body.trim(),
  }
}

/**
 * Watch the skill root for catalog-affecting changes.
 *
 * The existing tree is watched recursively, which is what makes a sync or an
 * editor save visible without a restart. A root that does not exist yet is
 * followed from its nearest existing ancestor, so running the sync script
 * after activation still registers the catalog.
 *
 * Events are coalesced because a sync rewrites the whole tree at once.
 * @param {string} root
 * @param {() => void} onChange
 * @returns {Array<() => void>} closers, to run on plugin disposal.
 */
function watchSkillRoot(root, onChange) {
  /** @type {Array<() => void>} */
  const closes = []
  /** @type {NodeJS.Timeout | undefined} */
  let pending
  const schedule = () => {
    if (pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      onChange()
    }, 150)
    pending.unref?.()
  }

  if (existsSync(root)) {
    try {
      const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename === null) return
        const changed = String(filename)
        // Directory additions and deletions have no extension; a renamed
        // directory therefore still refreshes the catalog.
        if (changed.endsWith('.md') || !changed.includes('.')) schedule()
      })
      watcher.on('error', () => {})
      closes.push(() => watcher.close())
    } catch {
      // `recursive` is unsupported on some platforms. Discovery still runs on
      // every catalog read when watching is disabled, so the catalog is never
      // permanently stale from the reader's point of view.
    }
  } else {
    const anchor = nearestExistingAncestor(root)
    const listener = () => {
      if (!existsSync(root)) return
      unwatchFile(anchor, listener)
      schedule()
    }
    watchFile(anchor, { interval: 1000, persistent: false }, listener)
    closes.push(() => unwatchFile(anchor, listener))
  }

  closes.push(() => {
    if (pending !== undefined) clearTimeout(pending)
  })
  return closes
}

/**
 * Nearest ancestor of `path` that exists, so a missing tree can be followed
 * from the first segment that will appear.
 * @param {string} path
 * @returns {string}
 */
function nearestExistingAncestor(path) {
  let candidate = path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return candidate
    candidate = parent
  }
  return candidate
}

/**
 * Directory names directly under `path`, sorted, following symlinks.
 * @param {string} path
 * @returns {string[]}
 */
function listDirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(path, entry.name))))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Regular-file names directly under `path`, sorted, following symlinks.
 * @param {string} path
 * @returns {string[]}
 */
function listFiles(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() || (entry.isSymbolicLink() && !isDirectory(join(path, entry.name))))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Render a path with `/` separators, the shape resource-base consumers expect.
 * @param {string} path
 * @returns {string}
 */
function toPortablePath(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * @typedef {object} Provenance
 * @property {string | undefined} repository
 * @property {string | undefined} commit
 * @property {string | undefined} version
 */

/**
 * @typedef {object} ParsedSkill
 * @property {string} name
 * @property {string} description
 * @property {string | undefined} whenToUse
 * @property {{ modelInvocable: boolean, userInvocable: boolean }} invocation
 * @property {string} content
 */

/**
 * A catalog candidate, in the shape `ctx.skills` validates.
 * @typedef {object} SkillRecord
 * @property {string} name
 * @property {string} description
 * @property {string} [whenToUse]
 * @property {{ modelInvocable: boolean, userInvocable: boolean }} invocation
 * @property {Record<string, string>} [metadata]
 * @property {string} source
 * @property {string} provider
 * @property {number} rank
 * @property {string} locator - absolute path of the `SKILL.md` owning the body.
 * @property {string} resourceDir - absolute directory of the skill's resources.
 * @property {string} path - the same file, exposed for catalog file previews.
 */

/**
 * A loaded skill, in the shape `ctx.skills` validates.
 * @typedef {object} LoadedSkill
 * @property {string} name
 * @property {string} description
 * @property {string} [whenToUse]
 * @property {{ modelInvocable: boolean, userInvocable: boolean }} invocation
 * @property {Record<string, string>} [metadata]
 * @property {string} content
 * @property {string} source
 * @property {string} provider
 * @property {{ kind: 'directory', path: string }} resourceBase
 * @property {string} path
 */
