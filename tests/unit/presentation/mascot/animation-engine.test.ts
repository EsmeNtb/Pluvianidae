import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnimationEngine, IAnimationPlayer } from '../../../../src/presentation/mascot/animation-engine';
import { MascotAnimation } from '../../../../src/core/models';

// Small durations so tests run fast (mirrors Searcher's injected
// searchTimeoutMs / IncrementalIndexer's injected softTimeoutMs pattern).
const ANALYSIS_COMPLETE_MS = 20;
const CELEBRATION_MS = 20;

class StubPlayer implements IAnimationPlayer {
  readonly played: MascotAnimation[] = [];

  playAnimation(animation: MascotAnimation): void {
    this.played.push(animation);
  }
}

function makeEngine(player: StubPlayer) {
  return new AnimationEngine(player, ANALYSIS_COMPLETE_MS, CELEBRATION_MS);
}

function types(player: StubPlayer): string[] {
  return player.played.map((a) => a.type);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AnimationEngine', () => {
  it('plays a single enqueued animation immediately', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    engine.enqueue({ type: 'idle' });

    expect(types(player)).toEqual(['idle']);
    engine.dispose();
  });

  it('plays multiple animations enqueued in rapid succession in arrival order without dropping any (10.7)', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    // Untimed animations enqueued back to back before any timer fires:
    // all must be played, in order, none omitted.
    engine.enqueue({ type: 'carrying-seed' });
    engine.enqueue({ type: 'perch-on-file', filePath: 'src/a.ts' });
    engine.enqueue({ type: 'idle' });
    engine.enqueue({ type: 'carrying-seed' });

    expect(player.played).toEqual([
      { type: 'carrying-seed' },
      { type: 'perch-on-file', filePath: 'src/a.ts' },
      { type: 'idle' },
      { type: 'carrying-seed' },
    ]);
    engine.dispose();
  });

  it('queues animations enqueued while a timed animation is in progress and plays them after its duration', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    engine.enqueue({ type: 'analysis-complete' });
    // Enqueued while analysis-complete's timer is still running.
    engine.enqueue({ type: 'carrying-seed' });
    engine.enqueue({ type: 'perch-on-file', filePath: 'src/b.ts' });

    // Only analysis-complete has played so far; queued items wait.
    expect(types(player)).toEqual(['analysis-complete']);

    vi.advanceTimersByTime(ANALYSIS_COMPLETE_MS);

    // Queue was non-empty when the timer fired: proceeds directly to the
    // next queued item (not idle), then drains the rest in order.
    expect(types(player)).toEqual(['analysis-complete', 'carrying-seed', 'perch-on-file']);
    engine.dispose();
  });

  it('auto-transitions analysis-complete to idle after its duration when the queue is empty (10.2)', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    engine.enqueue({ type: 'analysis-complete' });
    expect(types(player)).toEqual(['analysis-complete']);

    vi.advanceTimersByTime(ANALYSIS_COMPLETE_MS);

    expect(types(player)).toEqual(['analysis-complete', 'idle']);
    engine.dispose();
  });

  it('auto-transitions celebration to idle after its duration when the queue is empty (10.5)', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    engine.enqueue({ type: 'celebration' });
    expect(types(player)).toEqual(['celebration']);

    vi.advanceTimersByTime(CELEBRATION_MS);

    expect(types(player)).toEqual(['celebration', 'idle']);
    engine.dispose();
  });

  it('proceeds directly to the next queued item (not idle) if the queue is non-empty when celebration times out', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    engine.enqueue({ type: 'celebration' });
    engine.enqueue({ type: 'analysis-complete' });

    vi.advanceTimersByTime(CELEBRATION_MS);

    // Second timed animation now playing; idle should not appear yet.
    expect(types(player)).toEqual(['celebration', 'analysis-complete']);

    vi.advanceTimersByTime(ANALYSIS_COMPLETE_MS);
    expect(types(player)).toEqual(['celebration', 'analysis-complete', 'idle']);
    engine.dispose();
  });

  it('carrying-seed persists (no auto-timeout) until the next enqueued animation (10.3)', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    engine.enqueue({ type: 'carrying-seed' });
    expect(types(player)).toEqual(['carrying-seed']);

    // Advance well beyond any timed-animation duration: nothing more should play.
    vi.advanceTimersByTime(10_000);
    expect(types(player)).toEqual(['carrying-seed']);

    engine.enqueue({ type: 'idle' });
    expect(types(player)).toEqual(['carrying-seed', 'idle']);
    engine.dispose();
  });

  it('perch-on-file persists (no auto-timeout) until the next enqueued animation (10.4)', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    engine.enqueue({ type: 'perch-on-file', filePath: 'src/broken.ts' });
    expect(types(player)).toEqual(['perch-on-file']);

    vi.advanceTimersByTime(10_000);
    expect(types(player)).toEqual(['perch-on-file']);

    engine.enqueue({ type: 'celebration' });
    expect(types(player)).toEqual(['perch-on-file', 'celebration']);
    engine.dispose();
  });

  it('dispose() stops further processing and clears pending timers', () => {
    const player = new StubPlayer();
    const engine = makeEngine(player);

    engine.enqueue({ type: 'analysis-complete' });
    expect(types(player)).toEqual(['analysis-complete']);

    engine.dispose();

    // Timer for the idle fallback must not fire after dispose.
    vi.advanceTimersByTime(ANALYSIS_COMPLETE_MS + 100);
    expect(types(player)).toEqual(['analysis-complete']);

    // Further enqueue calls after dispose are no-ops.
    engine.enqueue({ type: 'celebration' });
    expect(types(player)).toEqual(['analysis-complete']);
  });
});
