/**
 * A deliberately small YAML-subset reader for `SKILL.md` frontmatter.
 *
 * Skills in `mattpocock/skills` use a narrow slice of YAML: one flat mapping
 * whose keys are plain scalars, plus a single nested `metadata` mapping. This
 * module covers that slice and rejects everything it does not understand, so a
 * future upstream construct fails loudly (one skipped skill with a warning)
 * instead of silently producing a truncated description.
 *
 * Supported per key:
 * - plain scalars, with a trailing ` # comment` stripped
 * - single-quoted scalars, `''` escaping a quote
 * - double-quoted scalars, including `\\ \" \/ \n \t \r \uXXXX` escapes
 * - literal (`|`) and folded (`>`) block scalars with `-`/`+` chomping
 * - a nested mapping (one or more levels), the shape `metadata` needs
 *
 * Not supported on purpose: sequences, flow collections, anchors, aliases,
 * tags, and multi-document streams. Those are unaffected by anything the
 * upstream repository ships today.
 *
 * @module dsh-plugin-mattpocock-skills/frontmatter
 */

/** A parsed frontmatter scalar or nested mapping. */
/** @typedef {string | boolean | null | { [key: string]: FrontmatterValue }} FrontmatterValue */

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?$/
const BLOCK_HEADER = /^([|>])([+-]?)[ \t]*(?:#.*)?$/
const TRUTHY = new Set(['true', 'yes', 'on', '1'])
const FALSY = new Set(['false', 'no', 'off', '0'])

/**
 * Split YAML frontmatter off the head of a Markdown document.
 * @param {string} raw - complete file text.
 * @returns {{ data: Record<string, FrontmatterValue>, body: string } | undefined}
 *   the parsed frontmatter and the remaining body, or `undefined` when the
 *   document does not open with a `---` fence.
 */
export function parseFrontmatter(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (fence === null) return undefined
  const block = fence[1]
  const lines = block.split(/\r?\n/)
  const { value, next } = parseMapping(lines, 0, 0)
  skipBlank(lines, next)
  if (next < lines.length) {
    throw new Error(`unexpected content at frontmatter line ${next + 1}: ${JSON.stringify(lines[next])}`)
  }
  return { data: /** @type {Record<string, FrontmatterValue>} */ (value ?? {}), body: text.slice(fence[0].length) }
}

/**
 * Resolve the invocation policy a skill's frontmatter declares.
 *
 * Upstream sets `disable-model-invocation: true` for skills the human must
 * invoke by name. Everything else defaults to reachable by both surfaces.
 * @param {Record<string, FrontmatterValue>} data - parsed frontmatter.
 * @returns {{ modelInvocable: boolean, userInvocable: boolean }}
 */
export function invocationPolicy(data) {
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`frontmatter field "${legacy}" is unsupported; use "disable-model-invocation"`)
    }
  }
  const disabled = readBoolean(data, 'disable-model-invocation')
  const user = readBoolean(data, 'user-invocable')
  return { modelInvocable: disabled !== true, userInvocable: user !== false }
}

/**
 * Read one optional boolean frontmatter field.
 * @param {Record<string, FrontmatterValue>} data
 * @param {string} key
 * @returns {boolean | undefined}
 */
function readBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.toLowerCase()
    if (TRUTHY.has(lowered)) return true
    if (FALSY.has(lowered)) return false
  }
  throw new Error(`frontmatter field "${key}" must be a boolean`)
}

/**
 * Parse an indentation-delimited mapping.
 * @param {string[]} lines
 * @param {number} start
 * @param {number} indent - the column the mapping's keys sit at.
 * @returns {{ value: Record<string, FrontmatterValue> | null, next: number }}
 */
function parseMapping(lines, start, indent) {
  const out = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (isBlankOrComment(line)) {
      index += 1
      continue
    }
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent > indent) {
      throw new Error(`unexpected indentation at frontmatter line ${index + 1}`)
    }
    const match = KEY_LINE.exec(line.slice(lineIndent))
    if (match === null) throw new Error(`invalid mapping entry at frontmatter line ${index + 1}`)
    const key = match[1]
    if (Object.hasOwn(out, key)) throw new Error(`duplicate frontmatter key "${key}"`)
    const rest = match[2] ?? ''
    if (rest.trim() === '' || rest.trimStart().startsWith('#')) {
      const nested = peekIndent(lines, index + 1)
      if (nested !== undefined && nested > indent) {
        const parsed = parseMapping(lines, skipBlank(lines, index + 1), nested)
        out[key] = parsed.value ?? {}
        index = parsed.next
      } else {
        out[key] = null
        index += 1
      }
      continue
    }
    const block = BLOCK_HEADER.exec(rest.trim())
    if (block !== null) {
      const parsed = parseBlockScalar(lines, index + 1, indent, block[1], block[2])
      out[key] = parsed.value
      index = parsed.next
      continue
    }
    out[key] = parseScalar(rest)
    index += 1
  }
  return { value: out, next: index }
}

/**
 * Read a `|` literal or `>` folded block scalar.
 * @param {string[]} lines
 * @param {number} start - first line of the block.
 * @param {number} parentIndent - indentation of the key owning the block.
 * @param {string} style - `|` or `>`.
 * @param {string} chomp - ``, `-`, or `+`.
 * @returns {{ value: string, next: number }}
 */
function parseBlockScalar(lines, start, parentIndent, style, chomp) {
  const collected = []
  let index = start
  let blockIndent
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      collected.push('')
      index += 1
      continue
    }
    const lineIndent = indentOf(line)
    if (lineIndent <= parentIndent) break
    blockIndent ??= lineIndent
    if (lineIndent < blockIndent) break
    collected.push(line.slice(blockIndent))
    index += 1
  }
  // Trailing blank lines belong to chomping, not to the text proper.
  let trailing = 0
  while (collected.length > 0 && collected[collected.length - 1] === '') {
    collected.pop()
    trailing += 1
  }
  let text
  if (style === '|') {
    text = collected.join('\n')
  } else {
    text = foldBlock(collected)
  }
  if (chomp === '+') text += '\n'.repeat(trailing + 1)
  else if (chomp === '') text += '\n'
  return { value: text, next: index }
}

/**
 * Fold block-scalar lines the way `>` does: one blank line becomes a newline,
 * a run of blank lines becomes that many newlines, and adjacent text joins
 * with a single space.
 * @param {string[]} lines
 * @returns {string}
 */
function foldBlock(lines) {
  let text = ''
  let pendingBreaks = 0
  let wrote = false
  for (const line of lines) {
    if (line === '') {
      pendingBreaks += 1
      continue
    }
    if (wrote) text += pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) : ' '
    text += line
    wrote = true
    pendingBreaks = 0
  }
  return text
}

/**
 * Parse one inline scalar value.
 * @param {string} raw - text after `key:`.
 * @returns {string}
 */
function parseScalar(raw) {
  const text = raw.trim()
  if (text.startsWith('"')) return parseDoubleQuoted(text)
  if (text.startsWith("'")) return parseSingleQuoted(text)
  if (text.startsWith('[') || text.startsWith('{')) throw new Error('flow collections are unsupported')
  if (text.startsWith('&') || text.startsWith('*') || text.startsWith('!')) {
    throw new Error('anchors, aliases, and tags are unsupported')
  }
  return stripComment(text)
}

/**
 * Remove a trailing ` # comment` from a plain scalar.
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '#') continue
    if (index === 0 || /\s/.test(text[index - 1])) return text.slice(0, index).trimEnd()
  }
  return text.trimEnd()
}

/**
 * Decode a double-quoted scalar, rejecting trailing content.
 * @param {string} text
 * @returns {string}
 */
function parseDoubleQuoted(text) {
  let out = ''
  let index = 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      const escape = text[index + 1]
      index += 2
      switch (escape) {
        case '"': out += '"'; break
        case '\\': out += '\\'; break
        case '/': out += '/'; break
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case '0': out += '\0'; break
        case 'u': {
          const hex = text.slice(index, index + 4)
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error('invalid \\u escape in a quoted scalar')
          out += String.fromCharCode(Number.parseInt(hex, 16))
          index += 4
          break
        }
        default: throw new Error(`unsupported escape "\\${escape}" in a quoted scalar`)
      }
      continue
    }
    if (char === '"') {
      const trailing = text.slice(index + 1).trim()
      if (trailing !== '' && !trailing.startsWith('#')) throw new Error('content after a closing quote')
      return out
    }
    out += char
    index += 1
  }
  throw new Error('unterminated double-quoted scalar')
}

/**
 * Decode a single-quoted scalar, rejecting trailing content.
 * @param {string} text
 * @returns {string}
 */
function parseSingleQuoted(text) {
  let out = ''
  let index = 1
  while (index < text.length) {
    if (text[index] === "'") {
      if (text[index + 1] === "'") {
        out += "'"
        index += 2
        continue
      }
      const trailing = text.slice(index + 1).trim()
      if (trailing !== '' && !trailing.startsWith('#')) throw new Error('content after a closing quote')
      return out
    }
    out += text[index]
    index += 1
  }
  throw new Error('unterminated single-quoted scalar')
}

/**
 * Column of the first non-space character.
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].length
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isBlankOrComment(line) {
  const trimmed = line.trimStart()
  return trimmed === '' || trimmed.startsWith('#')
}

/**
 * Advance past blank and comment-only lines.
 * @param {string[]} lines
 * @param {number} index
 * @returns {number}
 */
function skipBlank(lines, index) {
  let cursor = index
  while (cursor < lines.length && isBlankOrComment(lines[cursor])) cursor += 1
  return cursor
}

/**
 * Indentation of the next meaningful line, if it is indented at all.
 * @param {string[]} lines
 * @param {number} index
 * @returns {number | undefined}
 */
function peekIndent(lines, index) {
  const cursor = skipBlank(lines, index)
  if (cursor >= lines.length) return undefined
  return indentOf(lines[cursor])
}
