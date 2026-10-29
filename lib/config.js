/**
 * Row-config validation for `dsh-mattpocock-skills`.
 *
 * Every field is optional, so the shipped patch row needs no `config`. The
 * schema is built with `@deepseek-ai/schemastery` when the host can resolve it,
 * which lets `Config.listConfigs` render a real JSON Schema for the row; when
 * it cannot (a bare `node` run of the package, a test harness), the same
 * validation is exposed through the Standard Schema interface instead, so
 * activation behaves identically either way and the package keeps zero runtime
 * dependencies.
 *
 * Unknown keys are rejected rather than ignored: a typo in `skillRoot` would
 * otherwise silently fall back to the vendored tree and look like a bug in the
 * sync script.
 *
 * @module dsh-mattpocock-skills/config
 */

import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin name, used in validation messages. */
const PLUGIN = 'dsh-mattpocock-skills'

/** Default root, resolved beside the module so a linked checkout also works. */
export const DEFAULT_SKILL_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

/** Default provenance file written by `scripts/sync-skills.mjs`. */
export const DEFAULT_PROVENANCE = fileURLToPath(new URL('../skills/PROVENANCE.json', import.meta.url))

/** Keys a row may set. */
const KNOWN_KEYS = ['skillRoot', 'provenance', 'watch']

/**
 * @typedef {object} Settings
 * @property {string} skillRoot - absolute root holding one directory per skill.
 * @property {string | false} provenance - absolute manifest path, or `false` to skip attribution.
 * @property {boolean} watch - rebuild the catalog on filesystem changes.
 */

/**
 * Validate and normalize a row's raw config.
 * @param {unknown} value - raw Loader config.
 * @returns {Settings}
 * @throws {TypeError} when a field has the wrong type or a key is unknown.
 */
export function normalizeConfig(value) {
  if (value === undefined || value === null) value = {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${PLUGIN}: config must be a mapping`)
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) throw new TypeError(`${PLUGIN}: unknown config field "${key}"`)
  }
  return {
    skillRoot: pathField(raw.skillRoot, 'skillRoot', DEFAULT_SKILL_ROOT),
    provenance: raw.provenance === false ? false : pathField(raw.provenance, 'provenance', DEFAULT_PROVENANCE),
    // Schemastery materializes an omitted array as `[]` before this runs, so an
    // empty array means "no restriction", exactly like an omitted field.
    watch: raw.watch === undefined ? true : booleanField(raw.watch, 'watch'),
  }
}

/**
 * Resolve one path-shaped field against the process cwd.
 * @param {unknown} value
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function pathField(value, key, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${PLUGIN}: config "${key}" must be a non-empty string`)
  }
  return isAbsolute(value) ? value : resolve(value)
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {boolean}
 */
function booleanField(value, key) {
  if (typeof value !== 'boolean') throw new TypeError(`${PLUGIN}: config "${key}" must be a boolean`)
  return value
}

/**
 * Standard-Schema façade used when Schemastery is unavailable.
 * @returns {{ '~standard': { version: 1, vendor: string, validate: (value: unknown) => object } }}
 */
function standardOnlySchema() {
  return {
    '~standard': {
      version: 1,
      vendor: PLUGIN,
      validate(value) {
        try {
          return { value: normalizeConfig(value) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { issues: [{ message, path: [] }] }
        }
      },
    },
  }
}

/**
 * Load Schemastery from whichever anchor can resolve it.
 *
 * A bundle installed into a profile resolves harness packages from that
 * profile's `node_modules`, which is the first anchor that works in a real
 * profile. The remaining anchors keep a linked checkout, a global install, and
 * a bare `node` run of this package working, in that order of likelihood. A
 * miss in every anchor is not an error: the fallback keeps activation
 * behaviour identical, only `Config.listConfigs` loses its projection.
 * @returns {any | undefined}
 */
function loadSchemastery() {
  for (const anchor of resolutionAnchors()) {
    try {
      const req = createRequire(anchor)
      const loaded = req('@deepseek-ai/schemastery')
      const z = loaded?.default ?? loaded
      if (typeof z?.object === 'function') return z
    } catch {
      // Try the next anchor.
    }
  }
  return undefined
}

/**
 * Require anchors to try, most specific first.
 * @returns {string[]} a `createRequire` target: a module path, a package.json
 *   path, or a directory.
 */
function resolutionAnchors() {
  /** @type {string[]} */
  const anchors = [import.meta.url]
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir !== undefined && profileDir.length > 0) {
    anchors.push(join(profileDir, 'package.json'))
  }
  const { DSH_HOME, DSH_PROFILE } = process.env
  if (DSH_HOME !== undefined && DSH_HOME.length > 0 && DSH_PROFILE !== undefined && DSH_PROFILE.length > 0) {
    anchors.push(join(DSH_HOME, 'profiles', DSH_PROFILE, 'package.json'))
  }
  // The dsh launcher's own installation, when this module was imported from it.
  anchors.push(join(dirname(fileURLToPath(import.meta.url)), 'package.json'))
  return anchors
}

/**
 * Build the row's `Config` schema, preferring a native Schemastery schema so
 * `Config.listConfigs` can project it.
 * @returns {object}
 */
function buildConfig() {
  const z = loadSchemastery()
  if (typeof z?.object !== 'function') return standardOnlySchema()
  try {
    return z.object({
      skillRoot: z
        .string()
        .min(1)
        .description(
          'Directory holding one subdirectory per skill, each with a SKILL.md. Defaults to the vendored skills/ tree inside this package.',
        ),
      provenance: z
        .union([z.string().min(1), z.const(false)])
        .description(
          'PROVENANCE.json written by scripts/sync-skills.mjs, used for the catalog source label. Set false to omit attribution.',
        ),
      watch: z.boolean().description('Rebuild the catalog when a SKILL.md or bucket directory changes. Defaults to true.'),
    })
  } catch {
    return standardOnlySchema()
  }
}

/** The row's config schema. */
export const Config = buildConfig()
