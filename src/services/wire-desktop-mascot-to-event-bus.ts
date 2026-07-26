/**
 * Wire Desktop Mascot To Event Bus (`src/services/wire-desktop-mascot-to-event-bus.ts`).
 *
 * Implements tasks.md 13.2: the single piece that actually touches both
 * the internal Event Bus (`core/event-bus.ts`) and `DesktopMascotManager`,
 * translating each relevant `PluvianidaeEvent` into the `MascotEvent` the
 * desktop mascot understands via the pure mapping functions already
 * implemented in `mascot-event-mapper.ts` (task 13.1), then forwarding the
 * result to `desktopMascotManager.send(...)`.
 *
 * ## File placement decision
 *
 * This lives in its own file rather than inline in `extension.ts`, for the
 * same reason `local-mascot-server.ts`/`mascot-action-dispatcher.ts` are
 * their own files rather than methods on `DesktopMascotManager`: it keeps
 * `extension.ts` focused on high-level composition/wiring ("construct these
 * singletons, call this wiring function, push the result onto
 * `context.subscriptions`") rather than growing yet another block of
 * per-event-type `eventBus.on(...)` handlers inline in an already very
 * large file. It also makes this specific translation logic (which events
 * map to which mascot events, and the fail-safe try/catch around each one)
 * independently unit-testable against a fake `IEventBus` +
 * `DesktopMascotManager` double, without needing to exercise the rest of
 * `activate()`.
 *
 * ## Which events are wired
 *
 * `PluvianidaeEvent` (see `core/event-bus.ts`) has 8 variants, but
 * `mascot-event-mapper.ts` (task 13.1) only defines a pure mapping function
 * for 6 of them — `indexing:started`, `indexing:progress`,
 * `indexing:completed`, `analysis:finding`, `seed:created` and
 * `precommit:completed`. `seed:updated` and `mascot:animate` have no
 * corresponding `MascotEvent` translation defined anywhere in the design
 * (the mapping table in `mascot-event-mapper.ts`'s own doc comment lists
 * exactly these same 6, plus the generic "uncaught error" case) — the
 * desktop mascot's `MascotEvent` union has no variant that would
 * meaningfully represent "a seed changed state" or "the legacy webview
 * mascot's animation queue" beyond what `seed:created`/`indexing`/etc.
 * already convey, so this function deliberately does not subscribe to
 * those two event types rather than inventing an unspecified mapping.
 *
 * ## `seed:created` → `amount: 1`
 *
 * The Event Bus's real `seed:created` payload (`core/event-bus.ts`) is a
 * single `Seed`, not a batch/count — every `analysis:finding` produces
 * exactly one `Seed` via `seedEngine.createSeed(finding)` in
 * `extension.ts`. So each individual `seed:created` event received here is
 * translated with `amount: 1` (`mapSeedCreatedToMascotEvent(1)`), per this
 * task's explicit instruction — there is no "batch size" to read off the
 * event.
 *
 * ## Fail-safe error handling
 *
 * Every subscription handler below is wrapped in its own try/catch. If
 * mapping or sending throws for any reason, the error is translated with
 * `mapErrorToMascotEvent` and sent to the mascot as well (best-effort —
 * this second `send()` is itself wrapped so a failure translating/sending
 * the error can never throw back into the Event Bus's synchronous
 * dispatch loop). This matches `DesktopMascotManager`'s own philosophy
 * (see its doc comment): nothing about the mascot's plumbing may ever
 * throw into the rest of the extension. `eventBus.on(...)` dispatches
 * handlers synchronously (`EventBus.emit` in `core/event-bus.ts`), so an
 * uncaught exception here would propagate straight into whichever module
 * emitted the original event (e.g. `IndexBuilder`) — exactly what this
 * must prevent.
 *
 * ## No `vscode` dependency
 *
 * This module imports only `IEventBus`/`Disposable`
 * (`core/event-bus.ts`, already `vscode`-agnostic), `DesktopMascotManager`
 * and the pure mapping functions from `mascot-event-mapper.ts`. It never
 * imports `vscode` itself, keeping it testable without an Extension Host,
 * consistent with `mascot-event-mapper.ts`'s own stated design goal.
 */

import { Disposable, IEventBus, PluvianidaeEvent } from '../core/event-bus';
import { MascotEvent } from '../../shared/mascot-events';
import { DesktopMascotManager } from './desktop-mascot-manager';
import {
  mapIndexingStartedToMascotEvent,
  mapIndexingProgressToMascotEvent,
  mapIndexingCompletedToMascotEvent,
  mapFindingToMascotEvent,
  mapPrecommitCompletedToMascotEvent,
  mapSeedCreatedToMascotEvent,
  mapErrorToMascotEvent,
} from './mascot-event-mapper';

/**
 * `seed:created` payloads are individual `Seed`s (see this module's doc
 * comment > "`seed:created` → `amount: 1`"), so each event received here
 * always corresponds to exactly one newly created seed.
 */
const SINGLE_SEED_AMOUNT = 1;

/**
 * Subscribes `desktopMascotManager` to every relevant event on `eventBus`,
 * translating each one to a `MascotEvent` via `mascot-event-mapper.ts` and
 * forwarding it with `desktopMascotManager.send(...)`. Returns a single
 * `Disposable` that unsubscribes every registered handler at once — the
 * caller (`extension.ts`) is expected to push this straight onto
 * `context.subscriptions`, exactly like every other `eventBus.on(...)`
 * result already wired up there.
 *
 * Never throws: registration itself is a handful of synchronous
 * `eventBus.on(...)` calls (which themselves never throw per
 * `EventBus.on`'s implementation), and every handler body is individually
 * fail-safe (see this module's doc comment > "Fail-safe error handling").
 */
export function wireDesktopMascotToEventBus(
  eventBus: IEventBus,
  desktopMascotManager: DesktopMascotManager,
): Disposable {
  const subscriptions: Disposable[] = [
    eventBus.on('indexing:started', () => handleSafely(desktopMascotManager, () => mapIndexingStartedToMascotEvent())),

    eventBus.on('indexing:progress', (event) =>
      handleSafely(desktopMascotManager, () => {
        assertEventType(event, 'indexing:progress');
        const { current, total, currentFile } = event.payload;
        return mapIndexingProgressToMascotEvent(current, total, currentFile);
      }),
    ),

    eventBus.on('indexing:completed', (event) =>
      handleSafely(desktopMascotManager, () => {
        assertEventType(event, 'indexing:completed');
        return mapIndexingCompletedToMascotEvent(event.payload.filesIndexed);
      }),
    ),

    eventBus.on('analysis:finding', (event) =>
      handleSafely(desktopMascotManager, () => {
        assertEventType(event, 'analysis:finding');
        return mapFindingToMascotEvent(event.payload);
      }),
    ),

    eventBus.on('seed:created', () =>
      handleSafely(desktopMascotManager, () => mapSeedCreatedToMascotEvent(SINGLE_SEED_AMOUNT)),
    ),

    eventBus.on('precommit:completed', (event) =>
      handleSafely(desktopMascotManager, () => {
        assertEventType(event, 'precommit:completed');
        return mapPrecommitCompletedToMascotEvent(event.payload.hasErrors);
      }),
    ),
  ];

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Narrows `event` to the variant identified by `expectedType`. `EventBus`
 * (`core/event-bus.ts`) only ever invokes a handler registered for a given
 * `eventType` string with an event of that same `type`, so this should
 * always succeed in practice — but every other consumer of this event bus
 * in the codebase (e.g. `extension.ts`'s own subscriptions) defensively
 * re-checks `event.type` before touching `event.payload`, and this module
 * follows the same convention rather than trusting the bus's dispatch
 * mechanics implicitly.
 */
function assertEventType<T extends PluvianidaeEvent['type']>(
  event: PluvianidaeEvent,
  expectedType: T,
): asserts event is Extract<PluvianidaeEvent, { type: T }> {
  if (event.type !== expectedType) {
    throw new Error(`wireDesktopMascotToEventBus: evento inesperado "${event.type}" en el handler de "${expectedType}".`);
  }
}

/**
 * Runs `mapToMascotEvent`, sends its result via
 * `desktopMascotManager.send(...)`, and never lets an exception escape
 * back into the Event Bus's synchronous dispatch loop (see this module's
 * doc comment > "Fail-safe error handling"). On any failure — mapping
 * throwing, or the returned promise from `send()` rejecting — translates
 * the error with `mapErrorToMascotEvent` and attempts to send that
 * instead, itself guarded so a second failure is only logged, never
 * thrown.
 */
function handleSafely(desktopMascotManager: DesktopMascotManager, mapToMascotEvent: () => MascotEvent): void {
  try {
    const mascotEvent = mapToMascotEvent();
    void desktopMascotManager.send(mascotEvent).catch((err) => reportMappingOrSendError(desktopMascotManager, err));
  } catch (err) {
    reportMappingOrSendError(desktopMascotManager, err);
  }
}

/**
 * Translates an uncaught error from mapping/sending into a `MascotEvent`
 * and attempts to forward it to the mascot as well. Wrapped in its own
 * try/catch (and the resulting promise is `.catch()`ed with only a log) so
 * that a failure while reporting the *original* failure can never itself
 * escape as an unhandled exception or rejection.
 */
function reportMappingOrSendError(desktopMascotManager: DesktopMascotManager, err: unknown): void {
  try {
    const errorEvent = mapErrorToMascotEvent(err);
    void desktopMascotManager.send(errorEvent).catch((sendErr) => logWiringError(sendErr));
  } catch (mappingErr) {
    logWiringError(mappingErr);
  }
}

/**
 * Last-resort logging for a failure that occurred while already handling
 * another failure (mapping/sending the original event AND
 * mapping/sending the resulting error event both failed). Mirrors this
 * feature's existing `console.error` logging convention (see
 * `desktop-mascot-manager.ts`'s `logMascotManagerError`,
 * `local-mascot-server.ts`).
 */
function logWiringError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[Pluvianidae] wireDesktopMascotToEventBus: fallo no recuperable al notificar a la mascota de escritorio: ${message}`);
}
