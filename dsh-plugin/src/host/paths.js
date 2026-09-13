/**
 * Filesystem locations the bridge plugin depends on.
 *
 * The key file lives in the DSH home so both halves of the pairing (extension
 * settings and this plugin) can be provisioned by one install step.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Companion file holding the shared key and the trusted extension origins. */
export const COMPANION_FILE = 'dsh-web-companion.json'

/** Resolve the DSH home exactly like the launcher does (`$DSH_HOME` wins). */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Absolute path of the companion key file. */
export function companionPath(env = process.env) {
  return join(dshHome(env), COMPANION_FILE)
}

/** Directory holding bridge logs. */
export function logPath(env = process.env) {
  return join(dshHome(env), 'logs', 'dsh-web-companion-bridge.log')
}

/**
 * Metadata-only audit trail (JSONL). Deliberately a separate file from the rolling
 * log: it is the artifact you read *after* something unexplained happened, so it must
 * survive log rotation and be machine-readable.
 */
export function auditPath(env = process.env) {
  return join(dshHome(env), 'logs', 'web-companion-audit.jsonl')
}
