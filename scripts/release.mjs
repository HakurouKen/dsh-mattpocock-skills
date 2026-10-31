#!/usr/bin/env node
/**
 * release.mjs — decide the next version from what changed since the last tag.
 *
 * The version policy is a fact about the diff, not a judgement call:
 *
 *   major  the plugin's structure changed — its patch, its `lib/`, or the
 *          shape of `package.json` (name, entry, exports, files, dsh block).
 *          Never published automatically; a human runs the manual workflow.
 *   minor  a skill was added or removed (the set of `skills/<name>` changed).
 *   patch  skill content changed but the set did not.
 *   none   nothing in `skills/` or the structure moved since the last tag.
 *
 * Changes are measured against the last `v*` tag rather than the previous
 * commit, so several daily syncs fold into one release and a retried run is
 * idempotent.
 *
 * Commands:
 *   release.mjs plan              print a JSON plan, exit 0
 *   release.mjs apply <bump>      write the bumped version to package.json
 *   release.mjs version           print the current package version
 *   release.mjs tag               print the tag a release of this version uses
 *
 * @module dsh-plugin-mattpocock-skills/release
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = join(PACKAGE_DIR, 'package.json')
const SKILLS_DIR = join(PACKAGE_DIR, 'skills')

/** Tag prefix for releases. */
const TAG_PREFIX = 'v'

/** `package.json` keys that describe the plugin's structure rather than its content. */
const STRUCTURAL_KEYS = ['name', 'type', 'main', 'exports', 'files', 'engines', 'dsh']

/** Paths outside `skills/` whose change counts as a structural change. */
const STRUCTURAL_PATHS = ['cordis.patch.yml', 'lib']

/**
 * Run git and return trimmed stdout.
 * @param {string[]} args
 * @returns {string}
 */
function git(args, { quiet = false } = {}) {
  return execFileSync('git', args, {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Whether git found a difference, without throwing on a non-zero exit.
 * @param {string[]} args
 * @returns {boolean}
 */
function hasDiff(args) {
  try {
    git(['diff', '--quiet', ...args], { quiet: true })
    return false
  } catch (error) {
    // `git diff --quiet` exits 1 for "differs" and >1 for a real failure.
    if (error.status === 1) return true
    throw error
  }
}

/**
 * The most recent release tag, if any.
 * @returns {string | undefined}
 */
function lastTag() {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', `${TAG_PREFIX}[0-9]*`])
  } catch {
    return undefined
  }
}

/**
 * Skill directory names in the working tree: `<name>/SKILL.md` under `skills/`.
 * @returns {string[]}
 */
function currentSkills() {
  if (!existsSync(SKILLS_DIR)) return []
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Skill directory names recorded at a git ref.
 * @param {string} ref
 * @returns {string[]}
 */
function skillsAt(ref) {
  try {
    const out = git(['ls-tree', '-d', '--name-only', `${ref}:skills`])
    return out.split('\n').filter(Boolean).sort()
  } catch {
    // No `skills/` at that ref: everything currently present is new.
    return []
  }
}

/**
 * Compare the structural parts of `package.json` at a ref with the working tree.
 * @param {string} ref
 * @returns {boolean}
 */
function packageShapeChanged(ref) {
  let previous
  try {
    previous = JSON.parse(git(['show', `${ref}:package.json`]))
  } catch {
    return true
  }
  const current = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const pick = (manifest) => JSON.stringify(Object.fromEntries(STRUCTURAL_KEYS.map((key) => [key, manifest[key]])))
  return pick(previous) !== pick(current)
}

/**
 * Classify the change since the last tag.
 * @returns {{ bump: 'initial' | 'major' | 'minor' | 'patch' | 'none', reason: string, from: string | null, skills: number }}
 */
function plan() {
  const ref = lastTag()
  const skills = currentSkills()
  const version = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version

  if (ref === undefined) {
    return {
      bump: 'initial',
      reason: 'no release tag yet; the first publish is a manual decision',
      from: null,
      skills: skills.length,
    }
  }

  if (hasDiff([ref, '--', ...STRUCTURAL_PATHS]) || packageShapeChanged(ref)) {
    return { bump: 'major', reason: `plugin structure changed since ${ref}`, from: version, skills: skills.length }
  }

  const before = skillsAt(ref)
  if (before.join('\n') !== skills.join('\n')) {
    const added = skills.filter((name) => !before.includes(name))
    const removed = before.filter((name) => !skills.includes(name))
    const detail = [
      added.length > 0 ? `added ${added.join(', ')}` : '',
      removed.length > 0 ? `removed ${removed.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    return { bump: 'minor', reason: `skill set changed since ${ref}: ${detail}`, from: version, skills: skills.length }
  }

  // Content changes only. `PROVENANCE.json` is excluded because its `syncedAt`
  // moves without the skills changing.
  if (hasDiff([ref, '--', 'skills', ':(exclude)skills/PROVENANCE.json'])) {
    return { bump: 'patch', reason: `skill content changed since ${ref}`, from: version, skills: skills.length }
  }

  return { bump: 'none', reason: `no change since ${ref}`, from: version, skills: skills.length }
}

/**
 * Apply one bump to a semver string.
 * @param {string} version
 * @param {'major' | 'minor' | 'patch'} bump
 * @returns {string}
 */
export function bumpVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) throw new Error(`cannot parse version "${version}" as semver`)
  let [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (bump === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (bump === 'minor') {
    minor += 1
    patch = 0
  } else if (bump === 'patch') {
    patch += 1
  } else {
    throw new Error(`unknown bump "${bump}"`)
  }
  return `${major}.${minor}.${patch}`
}

function main(argv) {
  const [command, argument] = argv
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))

  if (command === 'plan') {
    process.stdout.write(`${JSON.stringify(plan(), undefined, 2)}\n`)
    return 0
  }
  if (command === 'version') {
    process.stdout.write(`${manifest.version}\n`)
    return 0
  }
  if (command === 'tag') {
    process.stdout.write(`${TAG_PREFIX}${manifest.version}\n`)
    return 0
  }
  if (command === 'apply') {
    if (!['major', 'minor', 'patch'].includes(argument)) {
      process.stderr.write('release: apply needs one of major, minor, patch\n')
      return 2
    }
    manifest.version = bumpVersion(manifest.version, argument)
    writeFileSync(PACKAGE_JSON, `${JSON.stringify(manifest, undefined, 2)}\n`)
    process.stdout.write(`${manifest.version}\n`)
    return 0
  }
  process.stderr.write('usage: release.mjs <plan|apply <bump>|version|tag>\n')
  return 2
}

// Only act when run directly, so a test can import `bumpVersion` without
// executing a release command.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
