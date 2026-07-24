/**
 * Event Bus (`core/event-bus.ts`)
 *
 * Internal pub/sub system for decoupled communication between Pluvianidae
 * modules. See design.md section "2. Event Bus (core/event-bus.ts)".
 *
 * Handlers registered for a given event type are invoked in registration
 * order, and events are processed in emission order (synchronous dispatch).
 */

import {
  IndexError,
  Finding,
  Seed,
  SeedState,
  MascotAnimation,
} from './models';

/**
 * Minimal `Disposable` shape compatible with `vscode.Disposable`
 * (an object exposing a `dispose()` method). Defined locally so this
 * module has no hard runtime dependency on the `vscode` module, while
 * remaining a valid argument to `vscode.ExtensionContext.subscriptions.push(...)`.
 */
export interface Disposable {
  dispose(): void;
}

export type PluvianidaeEvent =
  | { type: 'indexing:started'; payload: { totalFiles: number } }
  | {
      type: 'indexing:progress';
      payload: { current: number; total: number; currentFile: string };
    }
  | {
      type: 'indexing:completed';
      payload: { filesIndexed: number; errors: IndexError[] };
    }
  | { type: 'analysis:finding'; payload: Finding }
  | { type: 'seed:created'; payload: Seed }
  | { type: 'seed:updated'; payload: { id: string; newState: SeedState } }
  | { type: 'mascot:animate'; payload: MascotAnimation }
  /**
   * Fired when a pre-commit review (requirements.md Requirement 6) has
   * finished. Added by task 14.3 (`presentation/mascot/mascot-webview.ts`)
   * as an additive, backward-compatible event variant, purely so the
   * Mascota's Event-Bus wiring has something to listen for in order to
   * satisfy requirements.md 10.5 ("revisión pre-commit sin errores →
   * animación de celebración"). `PreCommitReviewer` (task 10.1) does not
   * yet *emit* this event — that emission wiring (deciding `hasErrors`
   * from a `PreCommitReport` and calling `eventBus.emit(...)` from the
   * pre-commit command handler) belongs to task 16.1's broader
   * "wire analysis findings" activation work. `hasErrors` is `true` when
   * the report contains at least one finding with severity `'error'` (or
   * detected secrets); `false` for a clean review.
   */
  | { type: 'precommit:completed'; payload: { hasErrors: boolean } };

/**
 * Extracts the literal `type` values from the `PluvianidaeEvent` union,
 * used to constrain `on`/`off`/`emit` event type arguments.
 */
export type PluvianidaeEventType = PluvianidaeEvent['type'];

export type PluvianidaeEventHandler = (event: PluvianidaeEvent) => void;

export interface IEventBus {
  emit(event: PluvianidaeEvent): void;
  on(eventType: string, handler: (event: PluvianidaeEvent) => void): Disposable;
  off(eventType: string, handler: (event: PluvianidaeEvent) => void): void;
}

/**
 * In-memory synchronous implementation of `IEventBus`.
 *
 * - `on` appends the handler to an ordered list per event type, so handlers
 *   fire in the order they were registered.
 * - `emit` dispatches synchronously to a snapshot of the handler list for
 *   that event's type, ensuring events are processed in emission order and
 *   that a handler added/removed during dispatch does not affect the
 *   in-flight emission.
 * - `on` returns a `Disposable` whose `dispose()` unregisters the handler,
 *   making it safe to use with `context.subscriptions.push(...)`.
 */
export class EventBus implements IEventBus {
  private readonly handlers = new Map<string, PluvianidaeEventHandler[]>();

  emit(event: PluvianidaeEvent): void {
    const existing = this.handlers.get(event.type);
    if (!existing || existing.length === 0) {
      return;
    }

    // Dispatch against a snapshot so mutations during dispatch (e.g. a
    // handler calling `off` or `on`) don't affect the current emission.
    const snapshot = existing.slice();
    for (const handler of snapshot) {
      handler(event);
    }
  }

  on(eventType: string, handler: PluvianidaeEventHandler): Disposable {
    const existing = this.handlers.get(eventType);
    if (existing) {
      existing.push(handler);
    } else {
      this.handlers.set(eventType, [handler]);
    }

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.off(eventType, handler);
      },
    };
  }

  off(eventType: string, handler: PluvianidaeEventHandler): void {
    const existing = this.handlers.get(eventType);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(handler);
    if (index !== -1) {
      existing.splice(index, 1);
    }
    if (existing.length === 0) {
      this.handlers.delete(eventType);
    }
  }
}
