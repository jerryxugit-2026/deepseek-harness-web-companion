/**
 * AUTO-GENERATED — do not edit. Source: protocol/messages.schema.json
 * protocolVersion: 1
 * schemaSha256: 0b03470c387e565e6fcaaf408d4de1177b46b3c43c2af8c9956a2271ca1b5e8f
 * platform: dsh-plugin (ESM)
 * Runtime: DSH host process (Node) / bundled client half.
 * Regenerate: node protocol/codegen.mjs   Verify: node protocol/codegen.mjs --check
 */

export const PROTOCOL_VERSION = 1
export const SCHEMA_SHA256 = '0b03470c387e565e6fcaaf408d4de1177b46b3c43c2af8c9956a2271ca1b5e8f'
export const SCHEMA_ID = 'https://dsh.local/web-companion/messages.schema.json'

/** Message kinds this protocol defines (from the schema's top-level oneOf). */
export const MESSAGE_KIND = Object.freeze({
  "PingResponse": "PingResponse",
  "TicketResponse": "TicketResponse",
  "AttachRequest": "AttachRequest",
  "AttachResponse": "AttachResponse",
  "PendingResponse": "PendingResponse",
  "AckRequest": "AckRequest",
  "ErrorEnvelope": "ErrorEnvelope",
  "WsRequest": "WsRequest",
  "WsResponse": "WsResponse",
  "WsEvent": "WsEvent",
  "WsHello": "WsHello",
  "WsPing": "WsPing",
  "WsPong": "WsPong",
  "ClientAttachEvent": "ClientAttachEvent",
  "ClientIntentEvent": "ClientIntentEvent",
  "ClientAckEvent": "ClientAckEvent",
  "ExtensionCaptureRequest": "ExtensionCaptureRequest",
  "ExtensionCaptureResponse": "ExtensionCaptureResponse",
  "NativeEnsureDsh": "NativeEnsureDsh",
  "NativeStatus": "NativeStatus",
  "NativeResponse": "NativeResponse"
})

/** Enum values the sides must agree on. */
export const ENUM = Object.freeze({
  "ErrorCode": [
    "E_AUTH",
    "E_VERSION",
    "E_PAYLOAD",
    "E_TOO_LARGE",
    "E_NO_WORKSPACE",
    "E_STORAGE",
    "E_EXT_OFFLINE",
    "E_TIMEOUT",
    "E_TARGET",
    "E_DSH_DOWN",
    "E_UNPAIRED",
    "E_NATIVE_MISSING",
    "E_NO_PERMISSION",
    "E_INTERNAL"
  ],
  "Trigger": [
    "look_left",
    "button",
    "shortcut",
    "manual"
  ],
  "CaptureMode": [
    "page",
    "selection",
    "screenshot",
    "auto"
  ],
  "AckStatus": [
    "inserted",
    "dismissed",
    "failed"
  ],
  "BrowserOp": [
    "read",
    "screenshot",
    "click",
    "type",
    "navigate",
    "tabs",
    "wait"
  ],
  "MessageKind": [
    "PingResponse",
    "TicketResponse",
    "AttachRequest",
    "AttachResponse",
    "PendingResponse",
    "AckRequest",
    "ErrorEnvelope",
    "WsRequest",
    "WsResponse",
    "WsEvent",
    "WsHello",
    "WsPing",
    "WsPong",
    "ClientAttachEvent",
    "ClientIntentEvent",
    "ClientAckEvent",
    "ExtensionCaptureRequest",
    "ExtensionCaptureResponse",
    "NativeEnsureDsh",
    "NativeStatus",
    "NativeResponse"
  ]
})

/** HTTP routes owned by the bridge plugin. */
export const ROUTE = Object.freeze({
  "ping": "/ag/ping",
  "ticket": "/ag/ticket",
  "enter": "/ag/enter",
  "attach": "/ag/attach",
  "pending": "/ag/pending",
  "ack": "/ag/ack",
  "whoami": "/ag/whoami",
  "probePage": "/ag/probe-page"
})

/** WebSocket channels owned by the bridge plugin. */
export const CHANNEL = Object.freeze({
  "agent": "/ag/agent",
  "client": "/ag/client"
})

/** The schema itself, embedded so each side is self-contained. */
export const MESSAGE_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://dsh.local/web-companion/messages.schema.json",
  "title": "DSH Web Companion protocol",
  "description": "Single source of truth for every message exchanged between the Chrome extension, the DSH bridge plugin (host and client halves) and the native messaging host. `protocol/codegen.mjs` turns this file into the three generated artifacts; each artifact carries the sha256 of this file and every side tests that it matches.",
  "protocolVersion": 1,
  "oneOf": [
    {
      "$ref": "#/$defs/PingResponse"
    },
    {
      "$ref": "#/$defs/TicketResponse"
    },
    {
      "$ref": "#/$defs/AttachRequest"
    },
    {
      "$ref": "#/$defs/AttachResponse"
    },
    {
      "$ref": "#/$defs/PendingResponse"
    },
    {
      "$ref": "#/$defs/AckRequest"
    },
    {
      "$ref": "#/$defs/ErrorEnvelope"
    },
    {
      "$ref": "#/$defs/WsRequest"
    },
    {
      "$ref": "#/$defs/WsResponse"
    },
    {
      "$ref": "#/$defs/WsEvent"
    },
    {
      "$ref": "#/$defs/WsHello"
    },
    {
      "$ref": "#/$defs/WsPing"
    },
    {
      "$ref": "#/$defs/WsPong"
    },
    {
      "$ref": "#/$defs/ClientAttachEvent"
    },
    {
      "$ref": "#/$defs/ClientIntentEvent"
    },
    {
      "$ref": "#/$defs/ClientAckEvent"
    },
    {
      "$ref": "#/$defs/ExtensionCaptureRequest"
    },
    {
      "$ref": "#/$defs/ExtensionCaptureResponse"
    },
    {
      "$ref": "#/$defs/NativeEnsureDsh"
    },
    {
      "$ref": "#/$defs/NativeStatus"
    },
    {
      "$ref": "#/$defs/NativeResponse"
    }
  ],
  "$defs": {
    "ErrorCode": {
      "type": "string",
      "enum": [
        "E_AUTH",
        "E_VERSION",
        "E_PAYLOAD",
        "E_TOO_LARGE",
        "E_NO_WORKSPACE",
        "E_STORAGE",
        "E_EXT_OFFLINE",
        "E_TIMEOUT",
        "E_TARGET",
        "E_DSH_DOWN",
        "E_UNPAIRED",
        "E_NATIVE_MISSING",
        "E_NO_PERMISSION",
        "E_INTERNAL"
      ]
    },
    "Error": {
      "type": "object",
      "required": [
        "code",
        "message"
      ],
      "additionalProperties": false,
      "properties": {
        "code": {
          "$ref": "#/$defs/ErrorCode"
        },
        "message": {
          "type": "string"
        },
        "detail": {}
      }
    },
    "ErrorEnvelope": {
      "type": "object",
      "required": [
        "ok",
        "error"
      ],
      "additionalProperties": false,
      "properties": {
        "ok": {
          "const": false
        },
        "error": {
          "$ref": "#/$defs/Error"
        }
      }
    },
    "Page": {
      "type": "object",
      "required": [
        "title",
        "url",
        "domain",
        "capturedAt"
      ],
      "additionalProperties": false,
      "properties": {
        "title": {
          "type": "string"
        },
        "url": {
          "type": "string"
        },
        "domain": {
          "type": "string"
        },
        "capturedAt": {
          "type": "number"
        },
        "hasVideo": {
          "type": "boolean"
        }
      }
    },
    "Screenshot": {
      "type": "object",
      "required": [
        "mime",
        "base64",
        "width",
        "height"
      ],
      "additionalProperties": false,
      "properties": {
        "mime": {
          "type": "string",
          "enum": [
            "image/png",
            "image/jpeg"
          ]
        },
        "base64": {
          "type": "string"
        },
        "width": {
          "type": "number"
        },
        "height": {
          "type": "number"
        },
        "bytes": {
          "type": "number"
        },
        "dropped": {
          "type": "boolean"
        },
        "dropReason": {
          "type": "string"
        }
      }
    },
    "PingResponse": {
      "type": "object",
      "required": [
        "ok",
        "protocolVersion",
        "plugin",
        "pluginVersion",
        "paired"
      ],
      "additionalProperties": true,
      "properties": {
        "ok": {
          "const": true
        },
        "protocolVersion": {
          "type": "number"
        },
        "plugin": {
          "type": "string"
        },
        "pluginVersion": {
          "type": "string"
        },
        "paired": {
          "type": "boolean"
        },
        "keyConfigured": {
          "type": "boolean"
        },
        "trustedOrigins": {
          "type": "number"
        },
        "pairingSource": {
          "type": "string"
        },
        "pairingError": {
          "type": [
            "string",
            "null"
          ]
        },
        "dsh": {
          "type": "object"
        },
        "capabilities": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "TicketResponse": {
      "type": "object",
      "required": [
        "ok",
        "ticket",
        "expiresAt"
      ],
      "additionalProperties": false,
      "properties": {
        "ok": {
          "const": true
        },
        "ticket": {
          "type": "string"
        },
        "expiresAt": {
          "type": "number"
        }
      }
    },
    "AttachRequest": {
      "type": "object",
      "required": [
        "protocolVersion",
        "captureId",
        "trigger",
        "page",
        "content"
      ],
      "additionalProperties": false,
      "properties": {
        "protocolVersion": {
          "type": "number"
        },
        "captureId": {
          "type": "string"
        },
        "trigger": {
          "type": "string",
          "enum": [
            "look_left",
            "button",
            "shortcut",
            "manual"
          ]
        },
        "page": {
          "$ref": "#/$defs/Page"
        },
        "content": {
          "type": "object",
          "required": [
            "markdown"
          ],
          "additionalProperties": false,
          "properties": {
            "markdown": {
              "type": "string"
            },
            "truncated": {
              "type": "boolean"
            },
            "selection": {
              "type": "object",
              "required": [
                "text"
              ],
              "additionalProperties": false,
              "properties": {
                "text": {
                  "type": "string"
                },
                "selectorHint": {
                  "type": "string"
                }
              }
            }
          }
        },
        "media": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "screenshot": {
              "$ref": "#/$defs/Screenshot"
            },
            "video": {
              "type": "object"
            }
          }
        },
        "target": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
              "type": "string"
            },
            "workspace": {
              "type": "string"
            }
          }
        }
      }
    },
    "AttachResponse": {
      "type": "object",
      "required": [
        "ok",
        "captureId",
        "fileRef",
        "filePath",
        "deliveredTo"
      ],
      "additionalProperties": false,
      "properties": {
        "ok": {
          "const": true
        },
        "captureId": {
          "type": "string"
        },
        "fileRef": {
          "type": "string"
        },
        "filePath": {
          "type": "string"
        },
        "imageRef": {
          "type": "object"
        },
        "deliveredTo": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "PendingResponse": {
      "type": "object",
      "required": [
        "ok",
        "items"
      ],
      "additionalProperties": false,
      "properties": {
        "ok": {
          "const": true
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ClientAttachEvent"
          }
        }
      }
    },
    "AckRequest": {
      "type": "object",
      "required": [
        "captureId",
        "status"
      ],
      "additionalProperties": false,
      "properties": {
        "captureId": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "inserted",
            "dismissed",
            "failed"
          ]
        },
        "detail": {
          "type": "string"
        }
      }
    },
    "WsRequest": {
      "type": "object",
      "required": [
        "type",
        "id",
        "op"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "request"
        },
        "id": {
          "type": "string"
        },
        "protocolVersion": {
          "type": "number"
        },
        "op": {
          "type": "string",
          "enum": [
            "read",
            "screenshot",
            "click",
            "type",
            "navigate",
            "tabs",
            "wait"
          ]
        },
        "args": {
          "type": "object"
        },
        "deadline": {
          "type": "number"
        }
      }
    },
    "WsResponse": {
      "type": "object",
      "required": [
        "type",
        "id",
        "ok"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "response"
        },
        "id": {
          "type": "string"
        },
        "ok": {
          "type": "boolean"
        },
        "result": {
          "type": "object"
        },
        "error": {
          "$ref": "#/$defs/Error"
        },
        "elapsedMs": {
          "type": "number"
        }
      }
    },
    "WsEvent": {
      "type": "object",
      "required": [
        "type",
        "kind",
        "payload"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "event"
        },
        "kind": {
          "type": "string"
        },
        "payload": {
          "type": "object"
        }
      }
    },
    "WsHello": {
      "type": "object",
      "required": [
        "type",
        "protocolVersion"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "hello"
        },
        "protocolVersion": {
          "type": "number"
        },
        "extVersion": {
          "type": "string"
        },
        "sessionId": {
          "type": "string"
        },
        "workspace": {
          "type": "string"
        },
        "capabilities": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "WsPing": {
      "type": "object",
      "required": [
        "type"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "ping"
        }
      }
    },
    "WsPong": {
      "type": "object",
      "required": [
        "type"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "pong"
        }
      }
    },
    "ClientAttachEvent": {
      "type": "object",
      "required": [
        "type",
        "captureId",
        "fileRef",
        "page",
        "mode"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "attach"
        },
        "protocolVersion": {
          "type": "number"
        },
        "captureId": {
          "type": "string"
        },
        "fileRef": {
          "type": "string"
        },
        "filePath": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "page",
            "selection",
            "screenshot",
            "selection+page"
          ]
        },
        "page": {
          "$ref": "#/$defs/Page"
        },
        "image": {
          "$ref": "#/$defs/Screenshot"
        },
        "imageRef": {
          "type": "object"
        },
        "summary": {
          "type": "object"
        }
      }
    },
    "ClientIntentEvent": {
      "type": "object",
      "required": [
        "type",
        "kind",
        "sessionId"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "intent"
        },
        "protocolVersion": {
          "type": "number"
        },
        "kind": {
          "type": "string",
          "enum": [
            "look-left"
          ]
        },
        "sessionId": {
          "type": "string"
        },
        "draft": {
          "type": "string"
        },
        "trigger": {
          "type": "string",
          "enum": [
            "keyword",
            "gesture"
          ]
        },
        "at": {
          "type": "number"
        }
      }
    },
    "ClientAckEvent": {
      "type": "object",
      "required": [
        "type",
        "captureId",
        "status"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "ack"
        },
        "captureId": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "inserted",
            "dismissed",
            "failed"
          ]
        },
        "detail": {
          "type": "string"
        }
      }
    },
    "ExtensionCaptureRequest": {
      "type": "object",
      "required": [
        "kind",
        "mode"
      ],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "const": "capture"
        },
        "mode": {
          "type": "string",
          "enum": [
            "page",
            "selection",
            "screenshot",
            "auto"
          ]
        },
        "trigger": {
          "type": "string",
          "enum": [
            "look_left",
            "button",
            "shortcut",
            "manual"
          ]
        }
      }
    },
    "ExtensionCaptureResponse": {
      "$ref": "#/$defs/AttachResponse"
    },
    "NativeEnsureDsh": {
      "type": "object",
      "required": [
        "id",
        "cmd"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string"
        },
        "cmd": {
          "const": "ensure-dsh"
        },
        "args": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "profile": {
              "type": "string"
            },
            "port": {
              "type": "number"
            },
            "timeoutMs": {
              "type": "number"
            }
          }
        }
      }
    },
    "NativeStatus": {
      "type": "object",
      "required": [
        "id",
        "cmd"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string"
        },
        "cmd": {
          "type": "string",
          "enum": [
            "status",
            "stop-dsh",
            "get-info"
          ]
        },
        "args": {
          "type": "object"
        }
      }
    },
    "NativeResponse": {
      "type": "object",
      "required": [
        "id",
        "ok"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string"
        },
        "ok": {
          "type": "boolean"
        },
        "result": {
          "type": "object"
        },
        "error": {
          "$ref": "#/$defs/Error"
        }
      }
    }
  }
}

function validateAgainst(schema, value, root, path) {
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
}
