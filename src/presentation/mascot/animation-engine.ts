/**
 * Mascota Animation Engine (`presentation/mascot/animation-engine.ts`).
 *
 * Queueing/timing layer that sits between "many animation requests
 * arriving, possibly simultaneously" and "one animation played at a time,
 * each for the correct duration, in arrival order". See design.md > "11.
 * Mascota Controller (`modules/mascot/`)" and requirements.md > Requirement
 * 10 (10.2, 10.3, 10.4, 10.5, 10.7 for this task specifically).
 *
 * ## Division of responsibility
 *
 * This engine does NOT do actual visual rendering — it only decides *when*
 * to invoke a downstream "play this animation now" delegate
 * (`IAnimationPlayer`, structurally identical to `MascotController`'s
 * `IMascotRenderer.playAnimation`, see `mascot-controller.ts`) and manages
 * the FIFO queue + per-animation durations around those invocations. Task
 * 14.3 (`mascot-webview.ts`) is expected to supply the real
 * `IAnimationPlayer`/`IMascotRenderer` implementation (webview-backed CSS/
 * SVG rendering) that this engine's `enqueue()` calls ultimately reach.
 *
 * ## Queue semantics (requirements.md 10.7 / design.md Property 22)
 *
 * `enqueue()` appends to an internal FIFO queue. Animations are drained
 * strictly in arrival order: **every** enqueued animation is eventually
 * passed to the player exactly once, in the order it was enqueued — this
 * engine never skips, drops, or coalesces queued animations, including
 * consecutive duplicate ones (e.g. two `idle` events back to back). This
 * is a deliberate interpretation of 10.7's "sin omitir eventos" ("without
 * omitting events"): the safest literal reading is "play every enqueued
 * animation, in order, no matter what", so no deduplication is performed.
 *
 * Processing only "blocks" the queue while a *timed* animation
 * (`analysis-complete` or `celebration`, see below) is within its
 * duration window. Untimed animations (`idle`, `carrying-seed`,
 * `perch-on-file`) are handed to the player and the engine immediately
 * continues draining the queue if more items are waiting — they impose no
 * minimum display time of their own, since the requirements attach no
 * duration to them (see per-animation notes below). This means several
 * untimed animations enqueued back to back are all still delivered to the
 * player, in order, without omission — just without an enforced pause
 * between them.
 *
 * ## Per-animation duration semantics
 *
 *   - `analysis-complete` (10.2) and `celebration` (10.5): each has a
 *     configurable max duration (defaulting to 3000ms, per
 *     `analysisCompleteDurationMs`/`celebrationDurationMs` constructor
 *     params — mirroring the injectable-timeout pattern used by
 *     `Searcher`'s `searchTimeoutMs` and `IncrementalIndexer`'s
 *     `softTimeoutMs`, so tests can use small values for speed). After
 *     that duration elapses: if the queue already has a next animation
 *     waiting, it is played immediately (the "return to idle" in 10.2/10.5
 *     happens naturally whenever the queue eventually drains, rather than
 *     being forced between every timed animation and the next queued
 *     one). If the queue is empty when the timer fires, the engine plays
 *     `idle` directly, satisfying "...antes de volver al estado inactivo"
 *     ("...before returning to the idle state"). This synthetic `idle`
 *     transition is generated internally (not pushed through `enqueue()`)
 *     since it is not an external event and therefore isn't subject to
 *     10.7's ordering guarantee.
 *   - `carrying-seed` (10.3) and `perch-on-file` (10.4): neither
 *     requirement specifies a duration the way 10.2/10.5 do for
 *     analysis-complete/celebration ("lleva una semilla" / "se posa" both
 *     describe an ongoing visual state, not a timed animation). This
 *     engine therefore treats both as **persisting indefinitely** — no
 *     timer is scheduled, and the player is not called again for them
 *     until a subsequent animation is enqueued. This is an interpretation
 *     documented here since the requirements are silent on their exact
 *     duration.
 *   - `idle`: the resting/default state. No timer, persists until the
 *     next enqueued (or internally-generated, see above) animation.
 */

import { MascotAnimation } from '../../core/models';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface IAnimationEngine {
  /** Adds `animation` to the FIFO queue; processed in arrival order (10.7). */
  enqueue(animation: MascotAnimation): void;
  /** Stops processing and clears any pending timers. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Narrow injection point for "play this animation now", structurally
 * compatible with `IMascotRenderer` from `mascot-controller.ts` (any
 * `IMascotRenderer` can be passed directly as an `IAnimationPlayer`).
 */
export interface IAnimationPlayer {
  playAnimation(animation: MascotAnimation): void;
}

/** requirements.md 10.2 / 10.5: default max duration before auto-returning to idle. */
export const DEFAULT_ANALYSIS_COMPLETE_DURATION_MS = 3000;
export const DEFAULT_CELEBRATION_DURATION_MS = 3000;

/** Animation types that auto-advance after a fixed duration (10.2, 10.5). */
const TIMED_ANIMATION_TYPES = new Set<MascotAnimation['type']>(['analysis-complete', 'celebration']);

// ---------------------------------------------------------------------------
// AnimationEngine
// ---------------------------------------------------------------------------

/**
 * Implements `IAnimationEngine`. See this module's doc comment for the full
 * queueing and duration semantics.
 */
export class AnimationEngine implements IAnimationEngine {
  private readonly queue: MascotAnimation[] = [];
  private timerHandle: ReturnType<typeof setTimeout> | undefined;
  private timerActive = false;
  private disposed = false;

  constructor(
    private readonly player: IAnimationPlayer,
    private readonly analysisCompleteDurationMs: number = DEFAULT_ANALYSIS_COMPLETE_DURATION_MS,
    private readonly celebrationDurationMs: number = DEFAULT_CELEBRATION_DURATION_MS,
  ) {}

  enqueue(animation: MascotAnimation): void {
    if (this.disposed) {
      return;
    }
    this.queue.push(animation);
    this.drainQueue();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.queue.length = 0;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Drains the FIFO queue while nothing is currently blocking on a timed
   * animation's duration window. Each iteration plays exactly the next
   * queued animation, in arrival order, per 10.7.
   */
  private drainQueue(): void {
    while (!this.disposed && !this.timerActive && this.queue.length > 0) {
      const next = this.queue.shift() as MascotAnimation;
      this.play(next);
    }
  }

  /**
   * Hands `animation` to the player and, if it is a timed type
   * (`analysis-complete`/`celebration`), starts its duration timer. On
   * expiry, either plays the next queued animation (if any) or returns to
   * `idle` directly (if the queue is empty) — see this module's doc
   * comment for why the `idle` fallback bypasses `enqueue()`.
   */
  private play(animation: MascotAnimation): void {
    this.player.playAnimation(animation);

    if (!TIMED_ANIMATION_TYPES.has(animation.type)) {
      return;
    }

    const duration = animation.type === 'celebration' ? this.celebrationDurationMs : this.analysisCompleteDurationMs;

    this.timerActive = true;
    this.timerHandle = setTimeout(() => {
      this.timerActive = false;
      this.timerHandle = undefined;
      if (this.disposed) {
        return;
      }
      if (this.queue.length > 0) {
        this.drainQueue();
      } else {
        this.play({ type: 'idle' });
      }
    }, duration);
  }

  private clearTimer(): void {
    if (this.timerHandle !== undefined) {
      clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
    this.timerActive = false;
  }
}
