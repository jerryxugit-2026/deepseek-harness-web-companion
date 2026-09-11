#!/usr/bin/env node
/**
 * Protocol code generator (design ADR-9 / docs/01 §7).
 *
 * Turns `protocol/messages.schema.json` — the single source of truth — into one
 * self-contained artifact per side, so the extension, the DSH plugin and the
 * native host can never drift apart silently:
 *
 *   extension/src/lib/protocol.generated.js   (ESM, browser)
 *   dsh-plugin/src/shared/protocol.generated.js (ESM, Node)
 *   native-host/protocol.generated.mjs        (ESM, Node)
 *
 * Every artifact carries the sha256 of the schema it was generated from; each
 * side runs `tests/protocol/contract.test.mjs`, which fails when the file on
 * disk no longer matches the schema (i.e. someone edited the schema and forgot
 * to regenerate, or hand-edited a generated file).
 *
 * Usage: node protocol/codegen.mjs [--check]
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SCHEMA_PATH = join(HERE, 'messages.schema.json')
const CHECK = process.argv.includes('--check')

const schemaText = readFileSync(SCHEMA_PATH, 'utf8')
const schema = JSON.parse(schemaText)
const sha256 = createHash('sha256').update(schemaText).digest('hex')

/** Message kinds a side can switch on: `$defs` names that are message-shaped. */
const MESSAGE_DEFS = schema.oneOf.map((ref) => ref.$ref.replace('#/$defs/', ''))
const ERROR_CODES = schema.$defs.ErrorCode.enum
const ENUMS = {
  ErrorCode: ERROR_CODES,
  Trigger: schema.$defs.AttachRequest.properties.trigger.enum,
  CaptureMode: schema.$defs.ExtensionCaptureRequest.properties.mode.enum,
  AckStatus: schema.$defs.AckRequest.properties.status.enum,
  BrowserOp: schema.$defs.WsRequest.properties.op.enum,
  MessageKind: MESSAGE_DEFS,
}

/**
 * A compact validator for the JSON-Schema subset this protocol uses. It is
 * emitted verbatim into each artifact so every side is self-contained (the
 * extension cannot import from `protocol/` at runtime).
 *
 * Supported: type (incl. arrays of types), enum, const, required, properties,
 * additionalProperties:false, items, oneOf, $ref. Unknown keywords are ignored
 * on purpose — unknown *keys* are not, because the protocol is closed.
 */
const VALIDATOR = `function validateAgainst(schema, value, root, path) {
  const fail = (reason) => ({ ok: false, path, reason })
  if (schema === null || typeof schema !== 'object') return { ok: true }

  if (schema.$ref !== undefined) {
    const target = root.$defs?.[schema.$ref.replace('#/$defs/', '')]
    if (target === undefined) return fail('unresolvable $ref ' + String(schema.$ref))
    return validateAgainst(target, value, root, path)
  }
  if (Array.isArray(schema.oneOf)) {
    const attempts = schema.oneOf.map((branch) => validateAgainst(branch, value, root, path))
    if (attempts.some((a) => a.ok)) return { ok: true }
    const reasons = [...new Set(attempts.map((a) => (a.ok ? '' : a.reason)))].filter((r) => r !== '')
    return fail('matches no oneOf branch (' + reasons.slice(0, 3).join(' | ') + ')')
  }
  if (schema.const !== undefined && value !== schema.const) return fail('expected const ' + JSON.stringify(schema.const))
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return fail('not in enum ' + JSON.stringify(schema.enum))

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const matches = types.some((t) => t === actual || (t === 'number' && actual === 'number' && Number.isFinite(value)) || (t === 'integer' && Number.isInteger(value)))
    if (!matches) return fail('expected ' + types.join('|') + ', got ' + actual)
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      const result = validateAgainst(schema.items, value[i], root, path + '[' + String(i) + ']')
      if (!result.ok) return result
    }
  }

  if (schema.properties !== undefined || schema.additionalProperties === false) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('expected object for properties check')
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return fail('missing required ' + key)
    }
    for (const [key, child] of Object.entries(value)) {
      const spec = properties[key]
      if (spec === undefined) {
        if (schema.additionalProperties === false) return fail('unexpected key ' + key)
        continue
      }
      const result = validateAgainst(spec, child, root, path + '.' + key)
      if (!result.ok) return result
    }
  }
  return { ok: true }
}

/** Validate one protocol message; returns { ok, error? } with a readable reason. */
export function validateMessage(value) {
  const result = validateAgainst(MESSAGE_SCHEMA, value, MESSAGE_SCHEMA, '$')
  if (result.ok) return { ok: true }
  return { ok: false, error: { code: 'E_PAYLOAD', message: result.reason + ' at ' + result.path } }
}

/** Validate an HTTP body for one named message definition. */
export function validateAs(definitionName, value) {
  const definition = MESSAGE_SCHEMA.$defs[definitionName]
  if (definition === undefined) return { ok: false, error: { code: 'E_INTERNAL', message: 'unknown definition ' + definitionName } }
  const result = validateAgainst(definition, value, MESSAGE_SCHEMA, '$')
  if (result.ok) return { ok: true }
  return { ok: false, error: { code: 'E_PAYLOAD', message: result.reason + ' at ' + result.path } }
}`

function artifact({ platform, extraHeader = '' }) {
  return `/**
 * AUTO-GENERATED — do not edit. Source: protocol/messages.schema.json
 * protocolVersion: ${String(schema.protocolVersion)}
 * schemaSha256: ${sha256}
 * platform: ${platform}
${extraHeader} * Regenerate: node protocol/codegen.mjs   Verify: node protocol/codegen.mjs --check
 */

export const PROTOCOL_VERSION = ${String(schema.protocolVersion)}
export const SCHEMA_SHA256 = '${sha256}'
export const SCHEMA_ID = '${schema.$id}'

/** Message kinds this protocol defines (from the schema's top-level oneOf). */
export const MESSAGE_KIND = Object.freeze(${JSON.stringify(Object.fromEntries(MESSAGE_DEFS.map((name) => [name, name])), null, 2)})

/** Enum values the sides must agree on. */
export const ENUM = Object.freeze(${JSON.stringify(ENUMS, null, 2)})

/** HTTP routes owned by the bridge plugin. */
export const ROUTE = Object.freeze(${JSON.stringify({
  ping: '/ag/ping',
  ticket: '/ag/ticket',
  enter: '/ag/enter',
  attach: '/ag/attach',
  pending: '/ag/pending',
  ack: '/ag/ack',
  whoami: '/ag/whoami',
  probePage: '/ag/probe-page',
}, null, 2)})

/** WebSocket channels owned by the bridge plugin. */
export const CHANNEL = Object.freeze(${JSON.stringify({ agent: '/ag/agent', client: '/ag/client' }, null, 2)})

/** The schema itself, embedded so each side is self-contained. */
export const MESSAGE_SCHEMA = ${JSON.stringify(schema, null, 2)}

${VALIDATOR}
`
}

const ARTIFACTS = [
  { path: join(ROOT, 'extension', 'src', 'lib', 'protocol.generated.js'), platform: 'chrome-extension (ESM)', extraHeader: ' * Runtime: browser (Chrome MV3).\n' },
  { path: join(ROOT, 'dsh-plugin', 'src', 'shared', 'protocol.generated.js'), platform: 'dsh-plugin (ESM)', extraHeader: ' * Runtime: DSH host process (Node) / bundled client half.\n' },
  { path: join(ROOT, 'native-host', 'protocol.generated.mjs'), platform: 'native-host (ESM)', extraHeader: ' * Runtime: native messaging host (Node, stdio frames).\n' },
]

let failures = 0
for (const artifactSpec of ARTIFACTS) {
  const content = artifact(artifactSpec)
  if (CHECK) {
    const existing = existsSync(artifactSpec.path) ? readFileSync(artifactSpec.path, 'utf8') : ''
    if (existing !== content) {
      console.error(`codegen: STALE — ${artifactSpec.path.slice(ROOT.length + 1)} does not match the schema`)
      failures += 1
    }
    continue
  }
  mkdirSync(dirname(artifactSpec.path), { recursive: true })
  writeFileSync(artifactSpec.path, content)
  console.log(`codegen: wrote ${artifactSpec.path.slice(ROOT.length + 1)} (${String(content.length)} bytes)`)
}

if (CHECK) {
  if (failures > 0) process.exit(1)
  console.log(`codegen: artifacts match schema ${sha256.slice(0, 12)}… (protocolVersion ${String(schema.protocolVersion)})`)
} else {
  console.log(`codegen: schema ${sha256.slice(0, 12)}… → ${String(ARTIFACTS.length)} artifacts`)
}
