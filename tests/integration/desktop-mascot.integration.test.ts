/**
 * Integration tests for the desktop-mascot feature (tasks.md 16.1–16.3).
 *
 * These tests use real (non-stubbed) implementations of `LocalMascotServer`,
 * `DesktopMascotManager` and `MascotActionDispatcher` — but deliberately
 * avoid spawning a real Electron process (which would require a graphical
 * environment in CI) by injecting a lightweight Node.js child process stub
 * instead. `LocalMascotServer` is exercised end-to-end against a real HTTP
 * socket, and SSE clients are real `http.request` connections.
 *
 * **Validates: Requirements 12.3 (16.1), 12.10 (16.2), 12.5/12.7/13.13 (16.3)**
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { createLocalMascotServer, type LocalMascotServer } from '../../src/services/local-mascot-server';
import { createMascotActionDispatcher } from '../../src/services/mascot-action-dispatcher';
import { DesktopMascotManager } from '../../src/services/desktop-mascot-manager';
import { deserializeMascotEvent, type MascotEvent } from '../../shared/mascot-events';
import { serializeMascotAction, type MascotAction } from '../../shared/mascot-actions';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/**
 * Opens a GET /events SSE connection and collects all validated
 * `MascotEvent`s received until `close()` is called.
 */
function connectSseTestClient(port: number): {
  received: MascotEvent[];
  close: () => void;
  /** Resolves once the HTTP response headers have been received (i.e. the
   *  server accepted the SSE connection), so callers can await readiness
   *  before broadcasting. */
  ready: Promise<void>;
} {
  const received: MascotEvent[] = [];
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  let buffer = '';
  const req = http.request(
    { host: '127.0.0.1', port, path: '/events', method: 'GET' },
    (res) => {
      resolveReady!();
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) {
            const event = deserializeMascotEvent(dataLine.slice('data: '.length));
            if (event) received.push(event);
          }
        }
      });
    },
  );
  req.on('error', () => {});
  req.end();

  return { received, close: () => req.destroy(), ready };
}

/**
 * Sends a POST /actions request and returns the HTTP status code.
 */
function postAction(port: number, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/actions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Polls until `predicate()` returns true or `timeoutMs` elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Minimal fake ChildProcess that stays alive until explicitly exited. */
function makeLongLivedFakeChild(): ChildProcess & { simulateExit: (code: number) => void } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { simulateExit: (code: number) => void };
  emitter.exitCode = null;
  emitter.killed = false;
  emitter.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      // Defer to next tick so the `graceTimer` in `terminateChildProcess()`
      // is always assigned before the 'exit' event fires.
      setTimeout(() => {
        emitter.exitCode = 0;
        emitter.killed = true;
        emitter.emit('exit', 0, signal);
      }, 0);
    }
    return true;
  }) as unknown as typeof process.kill;
  emitter.simulateExit = (code: number) => {
    emitter.exitCode = code;
    emitter.killed = true;
    emitter.emit('exit', code, null);
  };
  return emitter;
}

// ---------------------------------------------------------------------------
// 16.1 — LocalMascotServer + DesktopMascotManager SSE order / no-loss
// ---------------------------------------------------------------------------

describe('16.1 — MascotEvent delivery: order and no loss over a real SSE connection', () => {
  let server: LocalMascotServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('delivers every MascotEvent sent via DesktopMascotManager.send(...) in the exact emission order, without loss', async () => {
    // Arrange — real LocalMascotServer on an ephemeral port + a fake child
    // (never spawns real Electron) so DesktopMascotManager reaches 'running'.
    const fakeChild = makeLongLivedFakeChild();
    const manager = new DesktopMascotManager({
      preferredPort: 0,
      createServer: () => {
        server = createLocalMascotServer();
        return server;
      },
      spawnElectronProcess: () => fakeChild,
      desktopMascotDir: path.join(__dirname, '..', '..', 'desktop-mascot'),
      startupConfirmWindowMs: 20,
      stopGraceTimeoutMs: 200,
      retryIntervalMs: 60_000,
    });

    await manager.start();
    expect(manager.getState()).toBe('running');

    // Connect a real SSE test client.
    // @ts-expect-error — LocalMascotServer's real port is private; we cast to access it for the test client.
    const port: number = (server as unknown as { port: number }).port;
    const client = connectSseTestClient(port);
    await client.ready;
    // Give the server one tick to register the client before broadcasting.
    await new Promise((r) => setTimeout(r, 20));

    // Act — send a sequence of events that covers several MascotEvent types.
    const events: MascotEvent[] = [
      { type: 'idle' },
      { type: 'indexing', file: 'src/extension.ts', progress: 25 },
      { type: 'indexing', progress: 50 },
      { type: 'success', message: 'Indexación completa' },
      { type: 'warning', message: 'Hallazgo encontrado' },
      { type: 'error', message: 'Algo falló' },
      { type: 'seed', amount: 3 },
      { type: 'hide' },
      { type: 'show' },
    ];

    for (const event of events) {
      await manager.send(event);
    }

    // Wait for all events to arrive at the SSE client.
    await waitUntil(() => client.received.length >= events.length);
    client.close();

    // Assert — exact order, no loss.
    expect(client.received).toEqual(events);

    // Cleanup.
    await manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// 16.2 — MascotActionDispatcher: POST /actions dispatch + allowlist
// ---------------------------------------------------------------------------

describe('16.2 — POST /actions dispatch and allowlist enforcement', () => {
  let server: LocalMascotServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('dispatches the correct VS Code command when a valid MascotAction is posted to /actions', async () => {
    // Arrange.
    server = createLocalMascotServer();
    const { port } = await server.start(0);

    const executeCommand = vi.fn().mockResolvedValue(undefined);
    const fakeManager = { hide: vi.fn(), stop: vi.fn() } as unknown as DesktopMascotManager;
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: fakeManager, executeCommand });

    // Wire the dispatcher to the server's onAction callback (mimics extension.ts wiring).
    server.onAction((action) => { void dispatcher.dispatch(action); });

    // Act — post a valid 'precommit-review' action.
    const status = await postAction(port, serializeMascotAction({ action: 'precommit-review' }));

    // Assert — server accepted it (204) and dispatcher executed the command.
    expect(status).toBe(204);
    await waitUntil(() => (executeCommand as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
    expect(executeCommand).toHaveBeenCalledWith('pluvianidae.preCommitReview');
  });

  it('posts all 6 valid actions successfully (204) and dispatches each to the correct target', async () => {
    server = createLocalMascotServer();
    const { port } = await server.start(0);

    const executeCommand = vi.fn().mockResolvedValue(undefined);
    const hideManager = vi.fn().mockResolvedValue(undefined);
    const stopManager = vi.fn().mockResolvedValue(undefined);
    const fakeManager = { hide: hideManager, stop: stopManager } as unknown as DesktopMascotManager;
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: fakeManager, executeCommand });
    server.onAction((action) => { void dispatcher.dispatch(action); });

    const validActions: MascotAction[] = [
      { action: 'analyze-repository' },
      { action: 'precommit-review' },
      { action: 'show-seed-basket' },
      { action: 'mute-messages' },
      { action: 'hide-mascot' },
      { action: 'close-mascot' },
    ];

    for (const action of validActions) {
      const status = await postAction(port, serializeMascotAction(action));
      expect(status).toBe(204);
    }

    // Allow async dispatch to settle.
    await waitUntil(() => hideManager.mock.calls.length >= 1 && stopManager.mock.calls.length >= 1);

    expect(executeCommand).toHaveBeenCalledWith('pluvianidae.explainRepository');
    expect(executeCommand).toHaveBeenCalledWith('pluvianidae.preCommitReview');
    expect(executeCommand).toHaveBeenCalledWith('pluvianidae.seedBasket.focus');
    // mute-messages: no executeCommand call (it only logs)
    expect(hideManager).toHaveBeenCalledTimes(1);
    expect(stopManager).toHaveBeenCalledTimes(1);
  });

  it('rejects an action outside the allowlist with HTTP 400 and does not invoke any command', async () => {
    server = createLocalMascotServer();
    const { port } = await server.start(0);

    const executeCommand = vi.fn().mockResolvedValue(undefined);
    const fakeManager = { hide: vi.fn(), stop: vi.fn() } as unknown as DesktopMascotManager;
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: fakeManager, executeCommand });
    server.onAction((action) => { void dispatcher.dispatch(action); });

    // Post an action string that is not in the allowlist.
    const status = await postAction(port, JSON.stringify({ action: 'delete-everything' }));

    expect(status).toBe(400);
    // Give any async dispatch a moment to settle (should be zero calls).
    await new Promise((r) => setTimeout(r, 50));
    expect(executeCommand).not.toHaveBeenCalled();
    expect((fakeManager.hide as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((fakeManager.stop as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with HTTP 400 and does not invoke any command', async () => {
    server = createLocalMascotServer();
    const { port } = await server.start(0);

    const executeCommand = vi.fn().mockResolvedValue(undefined);
    const fakeManager = { hide: vi.fn(), stop: vi.fn() } as unknown as DesktopMascotManager;
    server.onAction((action) => {
      void createMascotActionDispatcher({ desktopMascotManager: fakeManager, executeCommand }).dispatch(action);
    });

    const status = await postAction(port, 'this is not JSON {{{');
    expect(status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 16.3 — DesktopMascotManager lifecycle: startup/shutdown + no orphans
// ---------------------------------------------------------------------------

describe('16.3 — DesktopMascotManager: startup/shutdown lifecycle and no orphan processes', () => {
  it('transitions to "running" when the fake child process does not exit early', async () => {
    const fakeChild = makeLongLivedFakeChild();
    const manager = new DesktopMascotManager({
      preferredPort: 0,
      spawnElectronProcess: () => fakeChild,
      desktopMascotDir: '/fake',
      startupConfirmWindowMs: 20,
      stopGraceTimeoutMs: 100,
      retryIntervalMs: 60_000,
    });

    await manager.start();
    expect(manager.getState()).toBe('running');

    await manager.dispose();
    expect(manager.getState()).toBe('stopped');
  });

  it('transitions to "unavailable" (fail-safe) when the fake child exits immediately with a non-zero code', async () => {
    const fakeChild = makeLongLivedFakeChild();
    const manager = new DesktopMascotManager({
      preferredPort: 0,
      spawnElectronProcess: () => fakeChild,
      desktopMascotDir: '/fake',
      startupConfirmWindowMs: 20,
      stopGraceTimeoutMs: 100,
      retryIntervalMs: 60_000,
    });

    // Emit a non-zero exit code shortly after spawn — simulates Electron
    // crashing right after being spawned.
    const startPromise = manager.start();
    // Allow the async server.start() to complete first.
    await new Promise((r) => setTimeout(r, 0));
    fakeChild.simulateExit(1);
    await startPromise;

    expect(manager.getState()).toBe('unavailable');
    await manager.dispose();
  });

  it('disposes cleanly with no live child process remaining after dispose()', async () => {
    const fakeChild = makeLongLivedFakeChild();
    const manager = new DesktopMascotManager({
      preferredPort: 0,
      spawnElectronProcess: () => fakeChild,
      desktopMascotDir: '/fake',
      startupConfirmWindowMs: 20,
      stopGraceTimeoutMs: 100,
      retryIntervalMs: 60_000,
    });

    await manager.start();
    expect(manager.getState()).toBe('running');

    // fakeChild is alive at this point.
    expect(fakeChild.killed).toBe(false);

    await manager.dispose();

    // After dispose(): the child must have been signalled and exited.
    expect(fakeChild.killed).toBe(true);
    expect(manager.getState()).toBe('stopped');
  });

  it('does not leave orphan processes after a failed start', async () => {
    // spawnElectronProcess throws synchronously (e.g. binary not found).
    const manager = new DesktopMascotManager({
      preferredPort: 0,
      spawnElectronProcess: () => { throw new Error('binary not found'); },
      desktopMascotDir: '/fake',
      startupConfirmWindowMs: 20,
      stopGraceTimeoutMs: 100,
      retryIntervalMs: 60_000,
    });

    // start() must resolve without throwing even when spawn fails.
    await expect(manager.start()).resolves.toBeUndefined();
    expect(manager.getState()).toBe('unavailable');

    // dispose() from 'unavailable' is a safe no-op that cancels retries.
    await expect(manager.dispose()).resolves.toBeUndefined();
    // State stays 'unavailable' (no server/child was ever alive — invariant).
    expect(manager.getState()).toBe('unavailable');
  });

  it('sends events correctly to a real SSE client while running', async () => {
    let localServer: LocalMascotServer | undefined;
    const fakeChild = makeLongLivedFakeChild();
    const manager = new DesktopMascotManager({
      preferredPort: 0,
      createServer: () => {
        localServer = createLocalMascotServer();
        return localServer;
      },
      spawnElectronProcess: () => fakeChild,
      desktopMascotDir: '/fake',
      startupConfirmWindowMs: 20,
      stopGraceTimeoutMs: 100,
      retryIntervalMs: 60_000,
    });

    await manager.start();
    // @ts-expect-error — access private port for test client
    const port: number = (localServer as unknown as { port: number }).port;
    const client = connectSseTestClient(port);
    await client.ready;
    await new Promise((r) => setTimeout(r, 20));

    await manager.send({ type: 'idle' });
    await manager.send({ type: 'success', message: 'done' });

    await waitUntil(() => client.received.length >= 2);
    client.close();

    expect(client.received).toEqual([{ type: 'idle' }, { type: 'success', message: 'done' }]);

    await manager.dispose();
  });
});
