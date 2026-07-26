/**
 * Mascot Event Mapper (`services/mascot-event-mapper.ts`)
 *
 * Pure translation layer between Pluvianidae's *internal* vocabulary
 * (Event Bus `PluvianidaeEvent`s, `Finding`s, pre-commit results, seed
 * creation, uncaught errors) and the desktop mascot's wire contract
 * (`shared/mascot-events.ts`'s `MascotEvent`).
 *
 * See design.md > "Integración con la extensión" >
 * "wireDesktopMascotToEventBus — mapeo de eventos internos a MascotEvent"
 * for the authoritative mapping table this module implements:
 *
 * ```
 * EVENTO INTERNO (Event Bus / comando)              MascotEvent ENVIADO
 *   indexing:started                                { type: 'indexing', progress: 0 }
 *   indexing:progress                                { type: 'indexing', file: currentFile, progress: current/total*100 }
 *   indexing:completed                               { type: 'success', message: 'Indexación completa (<N> archivos)' }
 *   analysis:finding (dead-code-detector)            { type: 'warning', message: finding.description }
 *   analysis:finding (frontend-backend-comparator)   { type: 'warning', message: finding.description }
 *   analysis:finding (pre-commit secreto detectado)  { type: 'error', message: 'Se detectó un posible secreto en <file>' }
 *   precommit:completed { hasErrors: false }         { type: 'success', message: 'Revisión pre-commit sin errores' }
 *   precommit:completed { hasErrors: true }          { type: 'warning', message: 'Revisión pre-commit con hallazgos' }
 *   seed:created                                     { type: 'seed', amount: <semillas creadas en este lote> }
 *   error no controlado en cualquier handler          { type: 'error', message: describeError(err) }
 * ```
 *
 * Deliberately kept free of any `vscode` import: this module must be
 * testable without an Extension Host, and reused as-is by
 * `wireDesktopMascotToEventBus` (task 13.2), which is the only piece
 * that touches the Event Bus and `vscode` APIs directly.
 *
 * Every function here returns a value that satisfies
 * `isMascotEvent` from `shared/mascot-events.ts` — free-text fields are
 * truncated to `MASCOT_EVENT_MAX_TEXT_LENGTH`, `progress` is clamped to
 * `[0, 100]`, and `amount` is clamped to `[1, 1000]` and rounded to an
 * integer, so a caller can always hand the result straight to
 * `DesktopMascotManager.send(...)` without further validation.
 */

import { Finding } from '../core/models';
import { MascotEvent, MASCOT_EVENT_MAX_TEXT_LENGTH } from '../../shared/mascot-events';

/**
 * `Finding.type` value used by `secretFindingToFinding` (`extension.ts`)
 * to identify findings that originate from the secret-detection check of
 * the Pre-Commit Reviewer. Kept as a named constant (rather than an
 * inline string literal at the call site) so the one place that
 * distinguishes "secret finding" from "any other finding" is easy to find
 * and keep in sync if that producer ever changes.
 */
const SECRET_FINDING_TYPE = 'precommit:secret';

/**
 * `indexing:started` -> `{ type: 'indexing', progress: 0 }`
 *
 * The internal `indexing:started` event carries a `totalFiles` count, but
 * the mascot's initial "just started" bubble has nothing meaningful to
 * show yet (no file has been processed), so no arguments are needed.
 */
export function mapIndexingStartedToMascotEvent(): MascotEvent {
  return { type: 'indexing', progress: 0 };
}

/**
 * `indexing:progress` -> `{ type: 'indexing', file: currentFile, progress: current/total*100 }`
 *
 * `progress` is clamped to `[0, 100]` to stay within `isMascotEvent`'s
 * validation range even if `total` is `0` (which would otherwise produce
 * `NaN` or `Infinity`) or if `current`/`total` arrive out of the expected
 * order. `currentFile` is truncated to `MASCOT_EVENT_MAX_TEXT_LENGTH` and
 * falls back to `undefined` (an omitted `file` field, which
 * `isMascotEvent` accepts) when empty.
 */
export function mapIndexingProgressToMascotEvent(
  current: number,
  total: number,
  currentFile: string,
): MascotEvent {
  const rawProgress = total > 0 ? (current / total) * 100 : 0;
  const progress = clampProgress(rawProgress);
  const file = truncateText(currentFile);

  return file === undefined
    ? { type: 'indexing', progress }
    : { type: 'indexing', file, progress };
}

/**
 * `indexing:completed` -> `{ type: 'success', message: 'Indexación completa (<N> archivos)' }`
 */
export function mapIndexingCompletedToMascotEvent(filesIndexed: number): MascotEvent {
  return {
    type: 'success',
    message: truncateRequiredText(`Indexación completa (${filesIndexed} archivos)`),
  };
}

/**
 * `analysis:finding` -> `{ type: 'warning', message: finding.description }`,
 * salvo que el `Finding` provenga de la detección de secretos del
 * Pre-Commit Reviewer (`finding.type === 'precommit:secret'`, ver
 * `secretFindingToFinding` en `extension.ts`), en cuyo caso se traduce a
 * `{ type: 'error', message: 'Se detectó un posible secreto en <file>' }`
 * usando `finding.filePath`.
 *
 * Covers both `dead-code-detector` and `frontend-backend-comparator`
 * findings (both map to `warning` with `finding.description` verbatim) as
 * well as the secret-detection special case, per the mapping table.
 */
export function mapFindingToMascotEvent(finding: Finding): MascotEvent {
  if (finding.type === SECRET_FINDING_TYPE) {
    const file = finding.filePath ?? 'archivo desconocido';
    return {
      type: 'error',
      message: truncateRequiredText(`Se detectó un posible secreto en ${file}`),
    };
  }

  return {
    type: 'warning',
    message: truncateRequiredText(finding.description),
  };
}

/**
 * `precommit:completed` -> `success`/`warning` según `hasErrors`.
 */
export function mapPrecommitCompletedToMascotEvent(hasErrors: boolean): MascotEvent {
  return hasErrors
    ? { type: 'warning', message: 'Revisión pre-commit con hallazgos' }
    : { type: 'success', message: 'Revisión pre-commit sin errores' };
}

/**
 * `seed:created` -> `{ type: 'seed', amount }`
 *
 * `amount` is rounded and clamped to `[1, 1000]` to satisfy
 * `isMascotEvent`'s `seed` validation (positive integer, max 1000) even
 * if the caller passes a batch count of `0`, a non-integer, or a value
 * above the wire limit.
 */
export function mapSeedCreatedToMascotEvent(amount: number): MascotEvent {
  return { type: 'seed', amount: clampSeedAmount(amount) };
}

/**
 * Cualquier error no controlado en un handler ->
 * `{ type: 'error', message: describeError(err) }`
 */
export function mapErrorToMascotEvent(err: unknown): MascotEvent {
  return { type: 'error', message: truncateRequiredText(describeError(err)) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats an unknown thrown value as a human-readable string.
 *
 * `extension.ts` and
 * `modules/pre-commit-reviewer/pre-commit-reviewer.ts` each already
 * define an equivalent `describeError(err: unknown): string` helper, but
 * neither exports it (both are private, module-local functions used only
 * within their own file's `catch` blocks), so there is nothing to import
 * here. This local copy intentionally mirrors their exact behavior
 * (`err instanceof Error ? err.message : String(err)`) to keep error
 * message formatting consistent across the codebase without introducing
 * a new shared dependency for a two-line function.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Truncates `text` to `MASCOT_EVENT_MAX_TEXT_LENGTH` characters, and maps
 * an empty string to `undefined` (used by `mapIndexingProgressToMascotEvent`
 * to omit the optional `file` field rather than send an empty string,
 * which `isMascotEvent` rejects for required `message` fields and is
 * meaningless for the optional `file` field).
 */
function truncateText(text: string): string | undefined {
  if (text.length === 0) {
    return undefined;
  }
  return text.length > MASCOT_EVENT_MAX_TEXT_LENGTH
    ? text.slice(0, MASCOT_EVENT_MAX_TEXT_LENGTH)
    : text;
}

/**
 * Truncates `text` to `MASCOT_EVENT_MAX_TEXT_LENGTH` characters for use in
 * a required `message` field (`success`/`warning`/`error`), which
 * `isMascotEvent` rejects if empty. Unlike `truncateText`, an empty input
 * falls back to a non-empty placeholder instead of `undefined`, so the
 * resulting `MascotEvent` always passes validation even if a producer
 * (e.g. a `Finding` with an empty `description`) hands us an empty string.
 */
function truncateRequiredText(text: string): string {
  return truncateText(text) ?? '(sin descripción)';
}

/** Clamps `value` to the `[0, 100]` range accepted by `isMascotEvent` for `progress`. */
function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

/**
 * Clamps `value` to the `[1, 1000]` integer range accepted by
 * `isMascotEvent` for `seed.amount`, rounding non-integers and treating
 * non-finite input as the minimum valid amount.
 */
function clampSeedAmount(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const rounded = Math.round(value);
  return Math.min(1000, Math.max(1, rounded));
}
