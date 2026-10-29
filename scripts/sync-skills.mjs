#!/usr/bin/env node
/**
 * sync-skills.mjs — vendor every skill from github.com/mattpocock/skills.
 *
 * The plugin ships the upstream tree instead of a hand-copied snapshot: this
 * script clones the repository at the requested ref, stages a mirror of
 * `skills/`, and only then replaces it. A later reader can tell exactly
 * which commit the bodies came from by reading the provenance manifest the
 * script writes. Re-run it to update; never edit `skills/` by hand.
 *
 * Usage:
 *   scripts/sync-skills.mjs                 # track the default branch
 *   scripts/sync-skills.mjs --ref v1.3.1    # pin a tag, branch, or commit
 *   scripts/sync-skills.mjs --check         # exit 1 when skills/ is stale
 *
 * Environment:
 *   MATTPOCOCK_SKILLS_REPO   clone URL    (default: https://github.com/mattpocock/skills.git)
 *   MATTPOCOCK_SKILLS_REF    ref to fetch (default: the repository's default branch)
 *
 * Exit codes: 0 success or up-to-date, 1 failure or stale, 2 bad arguments.
 *
 * @module dsh-mattpocock-skills/sync-skills
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(SCRIPT_DIR, '..')
const VENDOR_DIR = join(PACKAGE_DIR, 'skills')
const MANIFEST = join(VENDOR_DIR, 'PROVENANCE.json')

/**
 * Print usage, taken from this file's header so the two cannot drift.
 */
function usage() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  // The module starts with a shebang, then the doc block; capture the block
  // body up to the closing ` */` at column zero.
  const header = /\/\*\*\n([\s\S]*?)\n \*\//.exec(source)
  const text = header === null ? 'sync-skills.mjs' : header[1]
  process.stdout.write(
    text
      .split('\n')
      .map((line) => line.replace(/^ \* ?/, ''))
      .join('\n')
      // Drop the trailing `@module` tag; it documents the file, not the CLI.
      .replace(/\n\n@module[^\n]*\n?$/, '\n') + '\n',
  )
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`sync-skills: ${message}\n`)
  process.exit(1)
}

/**
 * @param {string} message
 * @returns {never}
 */
function misuse(message) {
  process.stderr.write(`sync-skills: ${message}\n`)
  process.exit(2)
}

/**
 * Parse argv into options.
 * @param {string[]} argv
 * @returns {{ repo: string, ref: string, check: boolean, help: boolean }}
 */
function parseArguments(argv) {
  let repo = process.env.MATTPOCOCK_SKILLS_REPO ?? 'https://github.com/mattpocock/skills.git'
  let ref = process.env.MATTPOCOCK_SKILLS_REF ?? ''
  let check = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
    } else if (argument === '--check') {
      check = true
    } else if (argument === '--ref') {
      const value = argv[index + 1]
      if (value === undefined) misuse('--ref needs a value')
      ref = value
      index += 1
    } else if (argument.startsWith('--ref=')) {
      ref = argument.slice('--ref='.length)
    } else if (argument === '--repo') {
      const value = argv[index + 1]
      if (value === undefined) misuse('--repo needs a value')
      repo = value
      index += 1
    } else if (argument.startsWith('--repo=')) {
      repo = argument.slice('--repo='.length)
    } else {
      misuse(`unknown argument ${argument}`)
    }
  }
  return { repo, ref, check, help }
}

/**
 * Run git and capture its trimmed stdout.
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnvironment(),
  }).trim()
}

/**
 * Run git with its output inherited, for a command whose progress the user
 * should see. Returns nothing: with inherited stdio Node captures no stdout.
 * @param {string[]} args
 */
function gitStreaming(args) {
  execFileSync('git', args, { stdio: 'inherit', env: gitEnvironment() })
}

/**
 * Environment for git calls: never block on a credential prompt, so a private
 * or misspelled URL fails with a diagnostic instead of hanging.
 * @returns {NodeJS.ProcessEnv}
 */
function gitEnvironment() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}

/**
 * Read a JSON file, returning `undefined` instead of throwing.
 * @param {string} path
 * @returns {any | undefined}
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Directory names directly under `path`, sorted with a byte-order comparison so
 * the output does not depend on the host locale.
 * @param {string} path
 * @returns {string[]}
 */
function listDirectories(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Copy a skill directory into the stage, preserving its resources.
 * @param {string} source
 * @param {string} destination
 */
function copySkill(source, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true, force: true })
}

/**
 * Build the staged mirror and its manifest.
 * @param {string} repoDir - cloned repository root.
 * @param {string} stage - empty directory to fill.
 * @param {{ repository: string, requestedRef: string }} origin
 * @returns {{ skills: number, commit: string, version: string }}
 */
function stageMirror(repoDir, stage, origin) {
  const skillsRoot = join(repoDir, 'skills')
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) {
    fail(`${origin.repository} has no skills/ directory; the upstream layout changed and the plugin needs updating`)
  }

  // Flatten `skills/<bucket>/<name>` to `skills/<name>`: the bucket is
  // upstream's organising device, not something a consumer needs, and skill
  // directory names are unique across buckets (asserted below), so one level is
  // enough. Each skill keeps its own resources beside its SKILL.md.
  /** @type {Map<string, string>} */
  const claimed = new Map()
  for (const bucket of listDirectories(skillsRoot)) {
    const bucketDir = join(skillsRoot, bucket)
    for (const name of listDirectories(bucketDir)) {
      if (!existsSync(join(bucketDir, name, 'SKILL.md'))) continue
      const owner = claimed.get(name)
      if (owner !== undefined) {
        fail(`upstream has two skills named "${name}" (${owner} and ${bucket}); the flat layout needs unique names`)
      }
      claimed.set(name, bucket)
      copySkill(join(bucketDir, name), join(stage, name))
    }
  }

  if (claimed.size === 0) fail('found no SKILL.md under skills/; nothing to vendor')

  // LICENSE only: attribution has to travel with the content. Upstream's
  // README, .claude-plugin metadata, and contributor docs are not used here.
  const license = join(repoDir, 'LICENSE')
  if (existsSync(license)) cpSync(license, join(stage, 'LICENSE'))

  const commit = git(['rev-parse', 'HEAD'], { cwd: repoDir })
  const commitDate = git(['log', '-1', '--format=%cI'], { cwd: repoDir })

  // Identify the content by what upstream actually published, never by a number
  // we choose. A tag is used only when this exact commit carries it; otherwise
  // the commit itself is the version, because upstream's `package.json` version
  // can name a release whose tag points at a different commit.
  let tag = ''
  try {
    // `--exact-match` yields a tag only when HEAD itself is tagged.
    tag = git(['describe', '--tags', '--exact-match', 'HEAD'], { cwd: repoDir })
  } catch {
    // No tag on this commit: the SHA is the identity.
  }
  const shortCommit = commit.slice(0, 12)
  // One identity field: the tag when this commit carries it, else the SHA.
  const version = tag !== '' ? tag : shortCommit
  const manifest = {
    $comment: 'Generated by scripts/sync-skills.mjs. Do not edit; re-run the script instead.',
    upstream: {
      repository: origin.repository,
      requestedRef: origin.requestedRef || null,
      commit,
      commitDate,
      version,
    },
    // Stamped only when the content changes: a scheduled run with no upstream
    // change writes nothing, so the tree (and git status) stay clean.
    syncedAt: new Date().toISOString(),
    skillCount: claimed.size,
  }
  writeFileSync(join(stage, 'PROVENANCE.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  return { skills: claimed.size, commit, version }
}

/**
 * Compare a freshly staged manifest with the vendored one.
 * @param {string} stagedPath
 * @param {string} currentPath
 * @returns {{ upToDate: boolean, reason: string }}
 */
function compare(stagedPath, currentPath) {
  const staged = readJson(stagedPath)
  const current = readJson(currentPath)
  if (staged === undefined) return { upToDate: false, reason: 'the staged manifest could not be read' }
  if (current === undefined) return { upToDate: false, reason: 'skills/ has no readable PROVENANCE.json' }
  if (staged.upstream.commit !== current.upstream?.commit) {
    return { upToDate: false, reason: `upstream moved from ${String(current.upstream?.commit).slice(0, 12)} to ${staged.upstream.commit.slice(0, 12)}` }
  }
  // The manifest no longer lists skills, so the set is compared on disk.
  const stagedNames = listSkillNames(stagedPath)
  const currentNames = listSkillNames(currentPath)
  if (stagedNames !== currentNames) return { upToDate: false, reason: 'the skill set changed upstream' }
  return { upToDate: true, reason: '' }
}

/**
 * List the skill directories beside a manifest file, for comparing two trees
 * without storing a redundant per-skill list in the manifest itself.
 * @param {string} manifestPath
 * @returns {string} sorted `bucket/name` entries joined with commas.
 */
function listSkillNames(manifestPath) {
  const skillsRoot = join(dirname(manifestPath), 'skills')
  if (!existsSync(skillsRoot)) return ''
  const names = []
  for (const bucket of listDirectories(skillsRoot)) {
    for (const name of listDirectories(join(skillsRoot, bucket))) {
      if (existsSync(join(skillsRoot, bucket, name, 'SKILL.md'))) names.push(`${bucket}/${name}`)
    }
  }
  return names.sort().join(',')
}

/**
 * Digest a staged or vendored tree so two runs can be compared by content.
 *
 * `PROVENANCE.json` carries a `syncedAt` stamp that changes on every run, so it
 * is normalized out: otherwise a scheduled sync would produce a commit that
 * only moves a timestamp, every single day, with no upstream change behind it.
 * @param {string} dir - tree to hash.
 * @returns {string} a digest stable across identical trees.
 */
function treeDigest(dir) {
  const hash = createHash('sha256')
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      const name = path.slice(dir.length + 1)
      hash.update(name).update('\0')
      if (name === join('PROVENANCE.json')) {
        const manifest = readJson(path)
        if (manifest === undefined) {
          hash.update(readFileSync(path))
        } else {
          // Keep every provenance field except the wall-clock stamp.
          hash.update(JSON.stringify({ ...manifest, syncedAt: '' }))
        }
      } else {
        hash.update(readFileSync(path))
      }
      hash.update('\0')
    }
  }
  walk(dir)
  return hash.digest('hex')
}

/**
 * Replace `skills/` with the stage. The previous tree is removed only after the
 * stage is complete, so an interrupted run leaves the old skills usable.
 * @param {string} stage
 */
function publish(stage) {
  rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(dirname(VENDOR_DIR), { recursive: true })
  cpSync(stage, VENDOR_DIR, { recursive: true, force: true })
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    usage()
    return 0
  }

  const workDir = mkdtempSync(join(tmpdir(), 'mattpocock-skills.'))
  try {
    const repoDir = join(workDir, 'repo')
    process.stdout.write(`==> cloning ${options.repo}${options.ref === '' ? '' : ` at ${options.ref}`}\n`)
    const cloneArgs = ['clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags']
    if (options.ref !== '') cloneArgs.push('--branch', options.ref)
    cloneArgs.push(options.repo, repoDir)
    try {
      gitStreaming(cloneArgs)
    } catch {
      fail('clone failed; check the network, the ref, and any proxy configuration')
    }

    const stage = join(workDir, 'stage')
    mkdirSync(stage, { recursive: true })
    const result = stageMirror(repoDir, stage, { repository: options.repo, requestedRef: options.ref })
    process.stdout.write(`    ${result.skills} skills\n`)

    if (options.check) {
      const { upToDate, reason } = compare(join(stage, 'PROVENANCE.json'), MANIFEST)
      if (upToDate) {
        process.stdout.write(`==> skills/ is up to date with ${result.version} (${result.commit.slice(0, 12)})\n`)
        return 0
      }
      process.stdout.write(`==> skills/ is stale: ${reason}\n    re-run scripts/sync-skills.mjs to update\n`)
      return 1
    }

    // Compare content, not the clock: a daily scheduled run must stay silent
    // when upstream has not moved, so it cannot commit a timestamp-only change.
    // `syncedAt` therefore records when the content last changed, not when it
    // was last checked; nothing is written here, keeping the work tree clean.
    if (existsSync(VENDOR_DIR) && treeDigest(stage) === treeDigest(VENDOR_DIR)) {
      process.stdout.write(`==> skills/ already matches ${result.version} (${result.commit.slice(0, 12)}); nothing to do\n`)
      return 0
    }

    publish(stage)
    process.stdout.write(`==> vendored ${result.skills} skills into skills/\n`)
    process.stdout.write(
      `    upstream ${result.version} @ ${result.commit.slice(0, 12)}\n`,
    )
    return 0
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

process.exitCode = await main()
