"use strict";
/**
 * Shared Mascot Event contract (`shared/mascot-events.ts`).
 *
 * Single source of truth for the message shape exchanged between the VS
 * Code extension (`src/services/mascot-ws-server.ts` /
 * `desktop-mascot-manager.ts`) and the standalone Electron desktop mascot
 * app (`desktop-mascot/src/renderer.ts`), over the local WebSocket
 * connection.
 *
 * Deliberately NOT duplicated into `desktop-mascot/src/`: both sides
 * import this exact file directly (the extension via a relative import,
 * Electron's `main`/`preload`/`renderer` via a relative import that
 * crosses the `desktop-mascot/` package boundary — see
 * `desktop-mascot/tsconfig.json`'s `rootDir`/`include` for how that's
 * wired without needing a build step to copy files around). This keeps
 * the two processes' understanding of the wire format from drifting apart
 * over time, which matters most here because the WebSocket server
 * (extension side) and its client (Electron side) are two independent
 * Node processes with no shared module graph otherwise.
 *
 * `MascotEvent` intentionally does NOT reuse `core/models.ts`'s
 * `MascotAnimation` type — that type models the *previous* VS Code
 * webview-based mascot's five animation states 1:1 with
 * requirements.md Requirement 10's wording. `MascotEvent` instead models
 * the *desktop* mascot's higher-level vocabulary (idle/indexing/success/
 * warning/error/seed/hide/show), which is richer in some ways (carries a
 * user-facing `message` for bubbles, an indexing `progress`/`file`, a
 * `seed` `amount`) and intentionally decoupled from the old renderer's
 * internal animation-state enum. `src/extension.ts` is responsible for
 * translating its own internal events (Event Bus `PluvianidaeEvent`s,
 * `Finding`s, etc.) into `MascotEvent`s at the point where it calls
 * `DesktopMascotManager.send(...)`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deserializeMascotEvent = exports.serializeMascotEvent = exports.isMascotEvent = exports.MASCOT_EVENT_MAX_TEXT_LENGTH = exports.MASCOT_EVENT_TYPES = void 0;
/** The literal `type` discriminants of `MascotEvent`, for exhaustive validation. */
exports.MASCOT_EVENT_TYPES = [
    'idle',
    'indexing',
    'success',
    'warning',
    'error',
    'seed',
    'hide',
    'show',
];
/**
 * Maximum length accepted for any free-text field (`message`, `file`).
 * Bubbles are meant to be small (see `desktop-mascot`'s bubble rendering,
 * which further truncates for display) — this cap exists primarily as a
 * defensive limit against a misbehaving or malicious sender flooding the
 * renderer with an enormous string over the WebSocket connection, not as
 * a display-formatting concern (that's `desktop-mascot/src/renderer.ts`'s
 * job).
 */
exports.MASCOT_EVENT_MAX_TEXT_LENGTH = 2000;
/**
 * Runtime type guard validating that `value` is a well-formed
 * `MascotEvent`. Used on both ends of the WebSocket connection:
 *   - The extension's WS server (`mascot-ws-server.ts`) does NOT need to
 *     validate *incoming* messages against this shape today (the desktop
 *     mascot app is not currently designed to send `MascotEvent`s back to
 *     the extension — see that file's doc comment on the deliberately
 *     narrow, extension-to-mascot-only message flow), but every outgoing
 *     `send(event)` call is validated against this guard before
 *     serialization, so a programming error inside the extension can
 *     never put a malformed message on the wire.
 *   - The desktop mascot app's preload/renderer validates every INCOMING
 *     message against this guard before touching the DOM with any of its
 *     fields, so a corrupted or unexpected payload is safely dropped
 *     (and logged) instead of being blindly trusted.
 *
 * Intentionally strict: unknown `type` values, wrong field types, missing
 * required fields, and unexpectedly-present extra fields on a message with
 * no fields (e.g. `{ type: 'idle', extra: 1 }`) are all rejected. This is
 * a deliberate defense-in-depth choice — see this module's doc comment and
 * `mascot-ws-server.ts`'s "no ejecutar código proveniente de los mensajes"
 * security requirement.
 */
function isMascotEvent(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value;
    if (typeof record.type !== 'string' || !exports.MASCOT_EVENT_TYPES.includes(record.type)) {
        return false;
    }
    switch (record.type) {
        case 'idle':
        case 'hide':
        case 'show':
            return Object.keys(record).length === 1;
        case 'indexing': {
            const allowedKeys = new Set(['type', 'file', 'progress']);
            if (!Object.keys(record).every((key) => allowedKeys.has(key))) {
                return false;
            }
            if (record.file !== undefined && !isValidText(record.file)) {
                return false;
            }
            if (record.progress !== undefined && !isValidProgress(record.progress)) {
                return false;
            }
            return true;
        }
        case 'success':
        case 'warning':
        case 'error':
            return Object.keys(record).length === 2 && isValidText(record.message);
        case 'seed':
            return Object.keys(record).length === 2 && isValidSeedAmount(record.amount);
        default:
            return false;
    }
}
exports.isMascotEvent = isMascotEvent;
function isValidText(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= exports.MASCOT_EVENT_MAX_TEXT_LENGTH;
}
function isValidProgress(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}
function isValidSeedAmount(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000;
}
/**
 * Serializes `event` to a JSON string for transmission over the local
 * WebSocket connection. Thin wrapper over `JSON.stringify` — kept as a
 * named function (rather than calling `JSON.stringify` inline at every
 * call site) so both ends of the connection agree on exactly one encoding
 * function, and so a future change to the wire format (e.g. adding a
 * version field) only needs to change this module.
 */
function serializeMascotEvent(event) {
    return JSON.stringify(event);
}
exports.serializeMascotEvent = serializeMascotEvent;
/**
 * Parses and validates a raw WebSocket message into a `MascotEvent`.
 * Returns `undefined` (never throws) when `raw` is not valid JSON, or
 * when the parsed value does not satisfy `isMascotEvent` — callers are
 * expected to log and drop the message rather than crash, per
 * `mascot-ws-server.ts`'s "registrar errores sin cerrar todo" requirement.
 */
function deserializeMascotEvent(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    return isMascotEvent(parsed) ? parsed : undefined;
}
exports.deserializeMascotEvent = deserializeMascotEvent;
//# sourceMappingURL=mascot-events.js.map