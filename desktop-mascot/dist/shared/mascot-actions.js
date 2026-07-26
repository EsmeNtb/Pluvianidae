"use strict";
/**
 * Shared Mascot Action contract (`shared/mascot-actions.ts`).
 *
 * Single source of truth for the message shape exchanged in the opposite
 * direction of `shared/mascot-events.ts`: from the standalone Electron
 * desktop mascot app (`desktop-mascot/src/renderer.ts` / `preload.ts` /
 * `main.ts`, triggered by the context menu) to the VS Code extension
 * (`src/services/local-mascot-server.ts` / `mascot-action-dispatcher.ts`),
 * over the local HTTP server's `POST /actions` endpoint.
 *
 * Deliberately kept as a sibling file rather than folded into
 * `mascot-events.ts`: that file documents an extension-to-mascot-only
 * message flow (`MascotEvent`), and mixing the two directions into one
 * type/file would break that documented guarantee and the exhaustiveness
 * of its existing type guard (`isMascotEvent`). Both ends import this
 * exact file directly by relative path; the type is never duplicated.
 *
 * Every `MascotAction` is a closed atom with no free-text parameters —
 * there is nothing to inject, so validation reduces to checking the
 * single `action` field against a fixed allowlist.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deserializeMascotAction = exports.serializeMascotAction = exports.isMascotAction = exports.MASCOT_ACTION_TYPES = void 0;
/** The literal `action` discriminants of `MascotAction`, for exhaustive validation. */
exports.MASCOT_ACTION_TYPES = [
    'analyze-repository',
    'precommit-review',
    'show-seed-basket',
    'mute-messages',
    'hide-mascot',
    'close-mascot',
];
/**
 * Runtime type guard validating that `value` is a well-formed
 * `MascotAction`. Used on both ends of the `/actions` HTTP endpoint:
 *   - The desktop mascot app's `preload.ts` validates every action before
 *     forwarding it from the renderer to `main.ts`, and `main.ts`
 *     validates again before making the `POST /actions` request.
 *   - The extension's `LocalMascotServer` validates every incoming
 *     `POST /actions` body against this guard before handing it to the
 *     action dispatcher, so a corrupted, unexpected, or malicious payload
 *     is safely dropped (and logged) instead of being blindly trusted.
 *
 * Intentionally strict: unknown `action` values, wrong field types, and
 * any additional field beyond the single `action` discriminant (e.g.
 * `{ action: 'hide-mascot', extra: 1 }`) are all rejected. There are no
 * free-text parameters on any `MascotAction`, so this rejects the entire
 * class of command-injection-style payloads by construction.
 */
function isMascotAction(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value;
    return (typeof record.action === 'string' &&
        exports.MASCOT_ACTION_TYPES.includes(record.action) &&
        Object.keys(record).length === 1);
}
exports.isMascotAction = isMascotAction;
/**
 * Serializes `action` to a JSON string for transmission over the local
 * HTTP connection. Thin wrapper over `JSON.stringify` — kept as a named
 * function (rather than calling `JSON.stringify` inline at every call
 * site) so both ends of the connection agree on exactly one encoding
 * function, and so a future change to the wire format only needs to
 * change this module.
 */
function serializeMascotAction(action) {
    return JSON.stringify(action);
}
exports.serializeMascotAction = serializeMascotAction;
/**
 * Parses and validates a raw HTTP request body into a `MascotAction`.
 * Returns `undefined` (never throws) when `raw` is not valid JSON, or
 * when the parsed value does not satisfy `isMascotAction` — callers are
 * expected to log and drop the message rather than crash, matching
 * `mascot-events.ts`'s `deserializeMascotEvent` behavior.
 */
function deserializeMascotAction(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    return isMascotAction(parsed) ? parsed : undefined;
}
exports.deserializeMascotAction = deserializeMascotAction;
//# sourceMappingURL=mascot-actions.js.map