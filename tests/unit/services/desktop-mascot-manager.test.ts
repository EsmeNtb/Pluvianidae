import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DesktopMascotManager } from '../../../src/services/desktop-mascot-manager';
import type { LocalMascotServer } from '../../../src/services/local-mascot-server';
import type { MascotEvent } from '../../../shared/mascot-events';

/**
 * Minimal fake `ChildProcess`: a real `EventEmitter` (so `.once('exit', ...)`
 * / `.on('error', ...)` behave like the real thing) plus a `kill()` spy and
 * mutable `exitCode`/`killed`, which is all `DesktopMascotManager` touches
 * on a child process.
 */
function makeFakeChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  emitter.exitCode = null;
  emitter.killed = false;
  emitter.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    // Simulate a real process eventually exiting after SIGKILL, but never
    // automatically after SIGTERM — tests that want a graceful exit emit
    // 'exit' themselves.
    if (signal === 'SIGKILL') {
      emitter.exitCode = 137;
      emitter.killed = true;
      emitter.emit('exit', null, 'SIGKILL');
    }
    return true;
  });
  return emitter;
}

/** Minimal fake `LocalMascotServer` recording calls, matching the real interface. */
function makeFakeServer(overrides: Partial<LocalMascotServer> = {}): LocalMascotServer & {
  broadcastCalls: MascotEvent[];
  stopCalls: number;
} {
  const broadcastCalls: MascotEvent[] = [];
  let stopCalls = 0;

  return {
    broadcastCalls,
    get stopCalls() {
      return stopCalls;
    },
    start: vi.fn(async (preferredPort: number) => ({ port: preferredPort === 0 ? 4123 : preferredPort })),
    broadcast: vi.fn((event: MascotEvent) => {
      broadcastCalls.push(event);
    }),
    onAction: vi.fn(() => ({ dispose: () => {} })),
    stop: vi.fn(async () => {
      stopCalls += 1;
    }),
    ...overrides,
  } as unknown as LocalMascotServer & { broadcastCalls: MascotEvent[]; stopCalls: number };
}

/** Builds a manager wired with fakes, plus a short confirmation window so tests run fast. */
function makeManager(options: {
  server?: LocalMascotServer;
  child?: ChildProcess;
  spawnError?: Error;
  retryIntervalMs?: number;
  startupConfirmWindowMs?: number;
} = {}) {
  const server = options.server ?? makeFakeServer();
  const child = options.child ?? makeFakeChild();
  const spawnElectronProcess = vi.fn(() => {
    if (options.spawnError) {
      throw options.spawnError;
    }
    return child;
  });

  const manager = new DesktopMascotManager({
    preferredPort: 0,
    createServer: () => server,
    spawnElectronProcess,
    desktopMascotDir: '/fake/desktop-mascot',
    startupConfirmWindowMs: options.startupConfirmWindowMs ?? 10,
    stopGraceTimeoutMs: 20,
    retryIntervalMs: options.retryIntervalMs ?? 10,
  });

  return { manager, server, child, spawnElectronProcess };
}

describe('DesktopMascotManager > state machine', () => {
  it('starts in idle', () => {
    const { manager } = makeManager();
    expect(manager.getState()).toBe('idle');
  });

  it('idle --start()--> running on success', async () => {
    const { manager } = makeManager();
    await manager.start();
    expect(manager.getState()).toBe('running');
  });

  it('starting --fallo--> unavailable when spawn throws synchronously, without start() rejecting', async () => {
    const { manager } = makeManager({ spawnError: new Error('binary not found') });
    await expect(manager.start()).resolves.toBeUndefined();
    expect(manager.getState()).toBe('unavailable');
  });

  /** Flushes both the microtask queue and one macrotask tick, enough for the mocked async `server.start()` to resolve and `spawnElectronProcess` to run. */
  function flushUntilSpawned(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('starting --fallo--> unavailable when the child emits "error" within the confirmation window', async () => {
    const child = makeFakeChild();
    // A generous confirmation window: this test needs to emit on `child`
    // strictly *before* the window elapses to exercise the "failed during
    // confirmation" branch rather than the post-startup guard.
    const { manager } = makeManager({ child, startupConfirmWindowMs: 1000 });

    const startPromise = manager.start();
    await flushUntilSpawned();
    child.emit('error', new Error('spawn EACCES'));
    await startPromise;

    expect(manager.getState()).toBe('unavailable');
  });

  it('starting --fallo--> unavailable when the child exits with a non-zero code within the confirmation window', async () => {
    const child = makeFakeChild();
    const { manager } = makeManager({ child, startupConfirmWindowMs: 1000 });

    const startPromise = manager.start();
    await flushUntilSpawned();
    child.emit('exit', 1, null);
    await startPromise;

    expect(manager.getState()).toBe('unavailable');
  });

  it('unavailable --start()--> running allows retrying after a previous failure', async () => {
    const { manager } = makeManager({ spawnError: new Error('boom') });
    await manager.start();
    expect(manager.getState()).toBe('unavailable');

    // Second manager reused via same fakes would still fail identically;
    // instead verify the *same* manager can retry once the underlying
    // condition is fixed by swapping in a working spawn function is not
    // possible post-construction, so this test targets the transition
    // itself: calling start() again from `unavailable` re-enters
    // `starting` and (with the same failing spawn) lands back in
    // `unavailable`, never getting stuck in `starting`.
    await manager.start();
    expect(manager.getState()).toBe('unavailable');
  });

  it('running --stop()--> stopped', async () => {
    const { manager } = makeManager();
    await manager.start();
    await manager.stop();
    expect(manager.getState()).toBe('stopped');
  });

  it('stopped --start()--> running allows restarting after a clean stop', async () => {
    const { manager } = makeManager();
    await manager.start();
    await manager.stop();
    await manager.start();
    expect(manager.getState()).toBe('running');
  });

  it('running --dispose()--> stopped', async () => {
    const { manager } = makeManager();
    await manager.start();
    await manager.dispose();
    expect(manager.getState()).toBe('stopped');
  });

  it('stop() and dispose() are safe no-ops from idle', async () => {
    const { manager } = makeManager();
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(manager.getState()).toBe('idle');
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(manager.getState()).toBe('idle');
  });

  it('dispose() is safe to call multiple times', async () => {
    const { manager } = makeManager();
    await manager.start();
    await manager.dispose();
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(manager.getState()).toBe('stopped');
  });

  it('a second start() while already starting/running does not spawn a second child', async () => {
    const { manager, spawnElectronProcess } = makeManager();
    await Promise.all([manager.start(), manager.start()]);
    expect(spawnElectronProcess).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe('running');
  });
});

describe('DesktopMascotManager > stop() child process termination', () => {
  it('sends SIGTERM and resolves once the child exits gracefully', async () => {
    const child = makeFakeChild();
    const { manager } = makeManager({ child });
    await manager.start();

    const stopPromise = manager.stop();
    // Simulate the child exiting on its own shortly after SIGTERM.
    child.emit('exit', 0, null);
    await stopPromise;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(manager.getState()).toBe('stopped');
  });

  it('escalates to SIGKILL if the child does not exit within the grace period', async () => {
    const child = makeFakeChild();
    const { manager } = makeManager({ child });
    await manager.start();

    await manager.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(manager.getState()).toBe('stopped');
  });

  it('closes the local server as part of stop()', async () => {
    const server = makeFakeServer();
    const { manager } = makeManager({ server });
    await manager.start();
    await manager.stop();

    expect(server.stop).toHaveBeenCalledTimes(1);
  });
});

describe('DesktopMascotManager > send()/show()/hide()', () => {
  it('send() broadcasts a valid event while running', async () => {
    const server = makeFakeServer();
    const { manager } = makeManager({ server });
    await manager.start();

    await manager.send({ type: 'success', message: 'listo' });

    expect(server.broadcastCalls).toEqual([{ type: 'success', message: 'listo' }]);
  });

  it('send() is a no-op (never throws) when not running', async () => {
    const server = makeFakeServer();
    const { manager } = makeManager({ server });

    await expect(manager.send({ type: 'idle' })).resolves.toBeUndefined();
    expect(server.broadcastCalls).toEqual([]);
  });

  it('send() discards an invalid event without throwing, even while running', async () => {
    const server = makeFakeServer();
    const { manager } = makeManager({ server });
    await manager.start();

    const invalidEvent = { type: 'idle', extra: 1 } as unknown as MascotEvent;
    await expect(manager.send(invalidEvent)).resolves.toBeUndefined();
    expect(server.broadcastCalls).toEqual([]);
  });

  it('show() sends { type: "show" } while running', async () => {
    const server = makeFakeServer();
    const { manager } = makeManager({ server });
    await manager.start();

    await manager.show();

    expect(server.broadcastCalls).toEqual([{ type: 'show' }]);
  });

  it('hide() sends { type: "hide" } while running', async () => {
    const server = makeFakeServer();
    const { manager } = makeManager({ server });
    await manager.start();

    await manager.hide();

    expect(server.broadcastCalls).toEqual([{ type: 'hide' }]);
  });

  it('show()/hide() are safe no-ops when unavailable', async () => {
    const { manager } = makeManager({ spawnError: new Error('boom') });
    await manager.start();
    expect(manager.getState()).toBe('unavailable');

    await expect(manager.show()).resolves.toBeUndefined();
    await expect(manager.hide()).resolves.toBeUndefined();
  });
});

describe('DesktopMascotManager > background retries while unavailable (tasks.md 4.2, requirements.md 8.3)', () => {
  it('automatically retries start() in the background after landing in unavailable, without any manual start() call', async () => {
    const { manager, spawnElectronProcess } = makeManager({
      spawnError: new Error('binary not found'),
      retryIntervalMs: 5,
    });

    await manager.start();
    expect(manager.getState()).toBe('unavailable');
    expect(spawnElectronProcess).toHaveBeenCalledTimes(1);

    // Nobody calls start() again here — the retry must fire on its own.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(spawnElectronProcess.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(manager.getState()).toBe('unavailable');
  });

  it('a successful background retry transitions to running and stops further retries', async () => {
    let shouldFail = true;
    const child = makeFakeChild();
    const spawnElectronProcess = vi.fn(() => {
      if (shouldFail) {
        throw new Error('temporary failure');
      }
      return child;
    });
    const server = makeFakeServer();

    const manager = new DesktopMascotManager({
      preferredPort: 0,
      createServer: () => server,
      spawnElectronProcess,
      desktopMascotDir: '/fake/desktop-mascot',
      startupConfirmWindowMs: 5,
      stopGraceTimeoutMs: 20,
      retryIntervalMs: 5,
    });

    await manager.start();
    expect(manager.getState()).toBe('unavailable');

    // Fix the underlying condition before the next background retry fires.
    shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(manager.getState()).toBe('running');

    const callsAfterSuccess = spawnElectronProcess.mock.calls.length;
    // No further retries should fire now that the manager is running.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawnElectronProcess.mock.calls.length).toBe(callsAfterSuccess);
  });

  it('stop() cancels a pending background retry even though it is otherwise a no-op from unavailable', async () => {
    const { manager, spawnElectronProcess } = makeManager({
      spawnError: new Error('binary not found'),
      retryIntervalMs: 5,
    });

    await manager.start();
    expect(manager.getState()).toBe('unavailable');
    const callsBeforeStop = spawnElectronProcess.mock.calls.length;

    await manager.stop();
    expect(manager.getState()).toBe('unavailable');

    // If the retry timer weren't cancelled, this would have fired another start().
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawnElectronProcess.mock.calls.length).toBe(callsBeforeStop);
  });

  it('dispose() cancels a pending background retry even though it is otherwise a no-op from unavailable', async () => {
    const { manager, spawnElectronProcess } = makeManager({
      spawnError: new Error('binary not found'),
      retryIntervalMs: 5,
    });

    await manager.start();
    expect(manager.getState()).toBe('unavailable');
    const callsBeforeDispose = spawnElectronProcess.mock.calls.length;

    await manager.dispose();
    expect(manager.getState()).toBe('unavailable');

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawnElectronProcess.mock.calls.length).toBe(callsBeforeDispose);
  });
});

describe('DesktopMascotManager > stop() child process termination > final child state after dispose()', () => {
  it('leaves the fake child in a terminated state (exitCode set, killed === true) once dispose() resolves, confirming no live process remains', async () => {
    const child = makeFakeChild();
    const { manager } = makeManager({ child });
    await manager.start();

    // Before dispose(): the fake child is alive, matching a real freshly
    // spawned process (`exitCode: null`, `killed: false`).
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);

    await manager.dispose();

    // After dispose(): the fake child's own SIGKILL simulation (see
    // `makeFakeChild`) has run, so `exitCode`/`killed` now reflect a
    // process that has actually exited — not just "a kill signal was
    // sent" (already covered by the `child.kill` assertions above), but
    // the process's own terminal state, which is what requirements.md
    // 12.7 ("no queda ningún proceso ... en ejecución") is ultimately
    // about.
    expect(child.exitCode).not.toBeNull();
    expect(child.killed).toBe(true);
    expect(manager.getState()).toBe('stopped');
  });
});

describe('DesktopMascotManager > Property 5: fail-safe startup (design.md > "Correctness Properties")', () => {
  /**
   * Flushes enough macrotask ticks for the mocked async `server.start()`
   * to resolve and `spawnElectronProcess` to run (and its child's
   * `'error'`/`'exit'` listeners to be attached) before a test emits on
   * the fake child.
   *
   * A single `setTimeout(resolve, 0)` tick is enough in isolation, but
   * under heavy CPU contention (e.g. this file running as part of the
   * full suite alongside many other property tests), a single macrotask
   * tick occasionally was not sufficient margin, letting the test's
   * `child.emit('error'/'exit', ...)` below race ahead of
   * `waitForEarlyChildFailure`'s listener registration and get silently
   * dropped (or, for `'error'`, throw synchronously per Node's
   * no-listener behavior) — the manager would then only settle once its
   * own internal timeout elapsed, landing in the wrong state or blowing
   * past this test's timeout. Three sequential ticks give ample headroom
   * while still resolving near-instantly in the common case.
   */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  type FailureMode =
    | { kind: 'spawnThrows'; message: string }
    | { kind: 'childError'; message: string }
    | { kind: 'childExit'; code: number | null };

  const failureModeArbitrary: fc.Arbitrary<FailureMode> = fc.oneof(
    fc.record({
      kind: fc.constant('spawnThrows' as const),
      message: fc.string({ minLength: 1, maxLength: 200 }),
    }),
    fc.record({
      kind: fc.constant('childError' as const),
      message: fc.string({ minLength: 0, maxLength: 200 }),
    }),
    fc.record({
      kind: fc.constant('childExit' as const),
      // Any exit code other than 0 counts as a startup failure per
      // design.md (a clean `exit 0` during the confirmation window is
      // the one code value `waitForEarlyChildFailure` treats as success,
      // so it's deliberately excluded here — this property is about
      // failure modes only).
      code: fc.oneof(fc.constant(null), fc.integer({ min: -128, max: 255 }).filter((c) => c !== 0)),
    })
  );

  // Feature: desktop-mascot, Property 5: Fail-safe en el arranque
  // "Para cualquier fallo durante start() (binario no encontrado, error de
  // spawn, timeout de arranque), el método SHALL resolver su promesa sin
  // lanzar, y el resto de la extensión SHALL continuar funcionando sin
  // bloquearse."
  it('resolves start() without throwing and lands in "unavailable" for any generated startup failure mode', async () => {
    await fc.assert(
      fc.asyncProperty(failureModeArbitrary, async (failureMode) => {
        // A huge retryIntervalMs (rather than the tiny default used by
        // other tests in this file) keeps each iteration's background
        // retry timer (requirements.md 8.3) from firing — and calling
        // spawnElectronProcess again — while a *later* iteration's
        // manager is mid-flight, which would otherwise let leftover
        // timers from earlier iterations interleave with the timing this
        // property is asserting on.
        const NO_RETRY_DURING_TEST_MS = 60_000;
        let manager: DesktopMascotManager;

        if (failureMode.kind === 'spawnThrows') {
          ({ manager } = makeManager({
            spawnError: new Error(failureMode.message),
            startupConfirmWindowMs: 1000,
            retryIntervalMs: NO_RETRY_DURING_TEST_MS,
          }));

          await expect(manager.start()).resolves.toBeUndefined();
        } else {
          const child = makeFakeChild();
          ({ manager } = makeManager({
            child,
            // A generous confirmation window: `flushMicrotasks` only needs
            // a single macrotask tick to let the mocked async
            // `server.start()` resolve and the child get spawned, but
            // under heavy CPU contention (e.g. running this file as part
            // of the full suite, alongside other slow property tests),
            // that single `setTimeout(0)` tick can occasionally take much
            // longer than expected. A short confirmation window could
            // then elapse first, making `waitForEarlyChildFailure` settle
            // as `'ok'` before this test's manual `child.emit(...)` below
            // ever runs — flipping the manager to `running` instead of
            // `unavailable` and failing the assertion below. 10s gives
            // ample headroom while the test itself still resolves as soon
            // as the event fires, never actually waiting for the window.
            startupConfirmWindowMs: 10_000,
            retryIntervalMs: NO_RETRY_DURING_TEST_MS,
          }));

          const startPromise = manager.start();
          await flushMicrotasks();

          if (failureMode.kind === 'childError') {
            child.emit('error', new Error(failureMode.message));
          } else {
            child.emit('exit', failureMode.code, null);
          }

          await expect(startPromise).resolves.toBeUndefined();
        }

        expect(manager.getState()).toBe('unavailable');
        // Cancel this iteration's pending background retry so it can
        // never fire during a later iteration.
        await manager.dispose();
      }),
      { numRuns: 50 }
    );
  });
});
