#!/usr/bin/env node
/**
 * sync-skills.mjs — vendor every skill from github.com/mattpocock/skills.
 *
 * The plugin ships the upstream tree instead of a hand-copied snapshot: this
 * script clones the repository at the requested ref, stages a mirror of
 * `skills/`, and only then replaces `vendor/`. A later reader can tell exactly
 * which commit the bodies came from by reading the provenance manifest the
 * script writes. Re-run it to update; never edit `vendor/` by hand.
 *
 * Usage:
 *   scripts/sync-skills.mjs                 # track the default branch
 *   scripts/sync-skills.mjs --ref v1.3.1    # pin a tag, branch, or commit
 *   scripts/sync-skills.mjs --check         # exit 1 when vendor/ is stale
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
const VENDOR_DIR = join(PACKAGE_DIR, 'vendor', 'mattpocock-skills')
const MANIFEST = join(VENDOR_DIR, 'PROVENANCE.json')

/** Files copied from the repository root, when present. */
const ROOT_DOCS = ['LICENSE', 'README.md']

/** Files copied from the repository root directory, when present. */
const ROOT_FILES = [join('.claude-plugin', 'plugin.json')]

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
 * First `name: value` occurrence inside a skill's YAML frontmatter.
 * @param {string} raw
 * @param {string} key
 * @returns {string}
 */
function frontmatterField(raw, key) {
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (fence === null) return ''
  const match = new RegExp(`^${key}[ \t]*:[ \t]*(.+)$`, 'm').exec(fence[1])
  return match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '')
}

/**
 * Whether the frontmatter marks the skill model-invocation-disabled.
 * @param {string} raw
 * @returns {boolean}
 */
function modelInvocable(raw) {
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (fence === null) return true
  return !/^disable-model-invocation[ \t]*:[ \t]*true[ \t]*$/m.test(fence[1])
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
 * @returns {{ skills: number, buckets: string[], commit: string, describe: string, version: string }}
 */
function stageMirror(repoDir, stage, origin) {
  const skillsRoot = join(repoDir, 'skills')
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) {
    fail(`${origin.repository} has no skills/ directory; the upstream layout changed and the plugin needs updating`)
  }

  const buckets = []
  /** @type {Array<{ name: string, directory: string, bucket: string, description: string, modelInvocable: boolean }>} */
  const skills = []

  for (const bucket of listDirectories(skillsRoot)) {
    const bucketDir = join(skillsRoot, bucket)
    const skillNames = listDirectories(bucketDir).filter((name) => existsSync(join(bucketDir, name, 'SKILL.md')))
    if (skillNames.length === 0) continue
    buckets.push(bucket)
    for (const name of skillNames) {
      const source = join(bucketDir, name)
      copySkill(source, join(stage, 'skills', bucket, name))
      const raw = readFileSync(join(source, 'SKILL.md'), 'utf8')
      skills.push({
        name: frontmatterField(raw, 'name') || name,
        directory: `${bucket}/${name}`,
        bucket,
        description: frontmatterField(raw, 'description').slice(0, 200),
        modelInvocable: modelInvocable(raw),
      })
    }
    // Bucket READMEs document the user-invoked / model-invoked split upstream
    // uses; carry them so the vendored tree reads like the source.
    const readme = join(bucketDir, 'README.md')
    if (existsSync(readme)) {
      mkdirSync(join(stage, 'skills', bucket), { recursive: true })
      cpSync(readme, join(stage, 'skills', bucket, 'README.md'))
    }
  }

  if (skills.length === 0) fail('found no SKILL.md under skills/; nothing to vendor')
  skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  for (const doc of ROOT_DOCS) {
    const source = join(repoDir, doc)
    if (existsSync(source)) cpSync(source, join(stage, doc))
  }
  for (const file of ROOT_FILES) {
    const source = join(repoDir, file)
    if (!existsSync(source)) continue
    mkdirSync(dirname(join(stage, file)), { recursive: true })
    cpSync(source, join(stage, file))
  }

  const commit = git(['rev-parse', 'HEAD'], { cwd: repoDir })
  const commitDate = git(['log', '-1', '--format=%cI'], { cwd: repoDir })
  let describe = commit
  try {
    describe = git(['describe', '--tags', '--always'], { cwd: repoDir }) || commit
  } catch {
    // A shallow clone with --no-tags has nothing to describe; the SHA is enough.
  }
  const upstreamPackage = readJson(join(repoDir, 'package.json'))
  const version = typeof upstreamPackage?.version === 'string' ? upstreamPackage.version : ''

  const manifest = {
    $comment: 'Generated by scripts/sync-skills.mjs. Do not edit; re-run the script instead.',
    upstream: {
      repository: origin.repository,
      requestedRef: origin.requestedRef || null,
      commit,
      commitDate,
      describe,
      version: version || null,
    },
    syncedAt: new Date().toISOString(),
    skillCount: skills.length,
    buckets,
    skills,
  }
  writeFileSync(join(stage, 'PROVENANCE.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  return { skills: skills.length, buckets, commit, describe, version }
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
  if (current === undefined) return { upToDate: false, reason: 'vendor/ has no readable PROVENANCE.json' }
  if (staged.upstream.commit !== current.upstream?.commit) {
    return { upToDate: false, reason: `upstream moved from ${String(current.upstream?.commit).slice(0, 12)} to ${staged.upstream.commit.slice(0, 12)}` }
  }
  const stagedNames = staged.skills.map((skill) => skill.name).join(',')
  const currentNames = (current.skills ?? []).map((skill) => skill.name).join(',')
  if (stagedNames !== currentNames) return { upToDate: false, reason: 'the skill set changed upstream' }
  return { upToDate: true, reason: '' }
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
 * Replace `vendor/` with the stage. The previous tree is removed only after the
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
    process.stdout.write(`    ${result.skills} skills in ${result.buckets.length} buckets\n`)

    if (options.check) {
      const { upToDate, reason } = compare(join(stage, 'PROVENANCE.json'), MANIFEST)
      if (upToDate) {
        process.stdout.write(`==> vendor/ is up to date with ${result.describe} (${result.commit.slice(0, 12)})\n`)
        return 0
      }
      process.stdout.write(`==> vendor/ is stale: ${reason}\n    re-run scripts/sync-skills.mjs to update\n`)
      return 1
    }

    // Compare content, not the clock: a daily scheduled run must stay silent
    // when upstream has not moved, so it cannot commit a timestamp-only change.
    // `syncedAt` therefore records when the content last changed, not when it
    // was last checked; nothing is written here, keeping the work tree clean.
    if (existsSync(VENDOR_DIR) && treeDigest(stage) === treeDigest(VENDOR_DIR)) {
      process.stdout.write(`==> vendor/ already matches ${result.describe} (${result.commit.slice(0, 12)}); nothing to do\n`)
      return 0
    }

    publish(stage)
    process.stdout.write(`==> vendored ${result.skills} skills into vendor/mattpocock-skills\n`)
    process.stdout.write(
      `    upstream ${result.version === '' ? 'unknown version' : result.version} @ ${result.commit.slice(0, 12)} (${result.describe})\n`,
    )
    return 0
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

process.exitCode = await main()
