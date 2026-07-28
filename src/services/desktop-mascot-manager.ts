/**
 * Desktop Mascot Manager (`src/services/desktop-mascot-manager.ts`).
 *
 * Implements design.md > "Componente 1: `DesktopMascotManager`" and the
 * "Ciclo de vida" section: the public facade the extension uses to
 * control the entire lifecycle of the standalone Electron desktop mascot,
 * without any other extension module ever knowing about Electron or the
 * HTTP/SSE transport underneath.
 *
 * This module owns exactly two collaborators per instance:
 *   - a `LocalMascotServer` (see `local-mascot-server.ts`), created via
 *     `createLocalMascotServer()`;
 *   - a single Electron child process, spawned via `child_process.spawn`.
 *
 * Every public method is fail-safe by construction: nothing in this class
 * ever throws or rejects towards its caller (`extension.ts`). Any failure
 * — a missing Electron binary, a `spawn` error, an early child crash — is
 * logged and translated into a state transition (`unavailable`), never
 * into an unhandled exception. This matches requirements.md 8.3: "THE
 * DesktopMascotManager SHALL resolver sus métodos sin lanzar excepciones
 * ... SHALL registrar el fallo en el log ... y THE Extensión SHALL
 * continuar funcionando con normalidad."
 *
 * ## State machine (design.md > "Ciclo de vida" > "Máquina de estados del manager")
 *
 * ```
 * idle        --start()-->        starting
 * starting    --éxito-->          running
 * starting    --fallo-->          unavailable   // fail-safe, sin excepción
 * running     --stop()/dispose()--> stopping
 * stopping    --proceso terminado--> stopped
 * unavailable --start()-->        starting      // permite reintentar manualmente
 * stopped     --start()-->        starting
 * ```
 *
 * Invariant (design.md): in `idle`, `unavailable` and `stopped`, neither
 * an HTTP server is listening nor a child process is alive. `start()`,
 * `stop()` and `dispose()` are all idempotent with respect to this
 * invariant.
 *
 * ## Scope note for this task (tasks.md 4.1 / 4.2)
 *
 * Task 4.1 implemented the state machine and the six public methods with
 * a *basic* start/stop of the local server + child process. Task 4.2
 * (this revision) adds the guaranteed-resource-cleanup reinforcement and
 * the periodic background retry of `start()` while `unavailable`
 * (requirements.md 8.3: "THE DesktopMascotManager SHALL reintentar
 * periódicamente la conexión con App_Electron a lo largo de la sesión en
 * lugar de deshabilitar la funcionalidad de forma permanente" — see
 * `scheduleRetry()`/`cancelRetryTimer()` below). Still not yet
 * implemented (see tasks.md 12, 13, deliberately out of scope here):
 *   - the `MascotAction` dispatcher (`server.onAction(...)` wiring);
 *   - releasing Event Bus listeners registered by
 *     `wireDesktopMascotToEventBus` (`dispose()` here is exactly
 *     equivalent to `stop()`, per design.md's own spec for this method:
 *     "equivalente a `stop()`, y además libera cualquier listener
 *     registrado por `wireDesktopMascotToEventBus`" — that Event-Bus part
 *     lands in task 13).
 *
 * ## "Successful startup" simplification (documented per task instructions)
 *
 * design.md's `start()` postcondition lists a 5000ms "timeout de
 * arranque" as one of several failure conditions, but also explicitly
 * notes there is no real startup-confirmation signal yet (that would come
 * from the Electron process's first successful SSE connection back to the
 * local server — out of scope until the `sse-client.ts`/dispatcher wiring
 * lands). Per the task's own guidance, "arranque exitoso" is simplified
 * here to: `spawn()` did not throw synchronously, and the child process
 * did not emit `'error'` nor exit with a non-zero/`null` code within a
 * short confirmation window (`STARTUP_CONFIRM_WINDOW_MS`, a few hundred
 * ms) after being spawned. This is intentionally a much shorter window
 * than the 5000ms figure mentioned in design.md — that longer timeout
 * belongs to the *real* startup-confirmation signal once it exists, not
 * to this best-effort "did the process immediately die" check.
 */

import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { MascotEvent, isMascotEvent } from '../../shared/mascot-events';
import { createLocalMascotServer, LocalMascotServer } from './local-mascot-server';

// ---------------------------------------------------------------------------
// Public state machine type
// ---------------------------------------------------------------------------

/** design.md > "Ciclo de vida" > "Máquina de estados del manager". */
export type DesktopMascotManagerState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'unavailable';

// ---------------------------------------------------------------------------
// Test seams (design.md's public constructor is `{ preferredPort: number }`;
// every field below is optional, so a caller passing only `preferredPort`
// still satisfies this wider interface structurally)
// ---------------------------------------------------------------------------

/**
 * Injectable launcher for the Electron child process, matching the
 * project's existing pattern for making `child_process`-backed
 * collaborators testable without spawning a real external binary (see
 * `pre-commit-reviewer.ts`'s `ICommandRunner` / `ChildProcessCommandRunner`).
 *
 * Deliberately takes `desktopMascotDir` (not an already-resolved Electron
 * binary path) so that resolving the real binary — which touches the
 * filesystem via `require()` and throws if `desktop-mascot/` was never
 * installed — stays entirely inside the *default* implementation
 * (`defaultSpawnElectronProcess`). An injected test double therefore
 * never has to have a real `desktop-mascot/node_modules/electron`
 * installed on disk to be exercised.
 */
export type SpawnElectronProcess = (desktopMascotDir: string, args: string[]) => ChildProcess;

export interface DesktopMascotManagerOptions {
  /** Port the local server should try to bind first (`0` = autodetect). */
  preferredPort: number;
  /** Test seam: overrides the default `createLocalMascotServer()` factory. */
  createServer?: () => LocalMascotServer;
  /** Test seam: overrides the default `child_process.spawn`-backed launcher. */
  spawnElectronProcess?: SpawnElectronProcess;
  /** Test seam: overrides the resolved absolute path to the `desktop-mascot/` package directory. */
  desktopMascotDir?: string;
  /**
   * Test seam: how long (ms) to wait after spawning before considering
   * startup successful, absent any `'error'`/failing `'exit'` from the
   * child. Defaults to `STARTUP_CONFIRM_WINDOW_MS`. Tests can pass a tiny
   * value so they don't have to sleep for hundreds of ms.
   */
  startupConfirmWindowMs?: number;
  /**
   * Test seam: grace period (ms) between `SIGTERM` and the `SIGKILL`
   * escalation in `stop()`. Defaults to `STOP_GRACE_TIMEOUT_MS`.
   */
  stopGraceTimeoutMs?: number;
  /**
   * Test seam: how long (ms) to wait, while in `unavailable`, before
   * automatically retrying `start()` in the background. Defaults to
   * `RETRY_INTERVAL_MS`. Tests can pass a tiny value instead of waiting
   * 30 real seconds for a retry to fire.
   */
  retryIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** See this module's doc comment > "Successful startup simplification". */
const STARTUP_CONFIRM_WINDOW_MS = 300;

/** design.md > "Ciclo de vida" > `stop()`: "timeout de gracia (p. ej. 3000ms)". */
const STOP_GRACE_TIMEOUT_MS = 3000;

/**
 * How often (ms) to retry `start()` in the background while `unavailable`
 * (requirements.md 8.3). 30s is a reasonable middle ground: frequent
 * enough that a transient failure (e.g. the Electron binary appearing a
 * few seconds after a fresh `npm run mascot:install`, or a momentary port
 * conflict with another VS Code window that's itself still starting up)
 * self-heals within a session without the user noticing much delay, but
 * spaced out enough to not spam `spawn()`/log noise if the underlying
 * cause (e.g. Electron genuinely never installed) is persistent for the
 * entire session.
 */
const RETRY_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// DesktopMascotManager
// ---------------------------------------------------------------------------

export class DesktopMascotManager {
  private readonly preferredPort: number;
  private readonly createServerFn: () => LocalMascotServer;
  private readonly spawnElectronProcessFn: SpawnElectronProcess;
  private readonly desktopMascotDir: string;
  private readonly startupConfirmWindowMs: number;
  private readonly stopGraceTimeoutMs: number;
  private readonly retryIntervalMs: number;

  private state: DesktopMascotManagerState = 'idle';
  private server: LocalMascotServer | undefined;
  private childProcess: ChildProcess | undefined;
  /**
   * Handle of the pending background retry of `start()` scheduled while
   * `unavailable` (requirements.md 8.3). Present only while a retry is
   * pending; always cleared via `cancelRetryTimer()`, never left running
   * once the manager leaves `unavailable` for any reason (a successful
   * retry, or an explicit `stop()`/`dispose()`).
   */
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DesktopMascotManagerOptions) {
    this.preferredPort = options.preferredPort;
    this.createServerFn = options.createServer ?? createLocalMascotServer;
    this.desktopMascotDir = options.desktopMascotDir ?? resolveDefaultDesktopMascotDir();
    this.spawnElectronProcessFn = options.spawnElectronProcess ?? defaultSpawnElectronProcess;
    this.startupConfirmWindowMs = options.startupConfirmWindowMs ?? STARTUP_CONFIRM_WINDOW_MS;
    this.stopGraceTimeoutMs = options.stopGraceTimeoutMs ?? STOP_GRACE_TIMEOUT_MS;
    this.retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
  }

  /** Current state machine value. Exposed for tests (not part of design.md's minimal interface, but a pure addition — no caller is required to use it). */
  getState(): DesktopMascotManagerState {
    return this.state;
  }

  // -------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------

  /**
   * design.md > "Ciclo de vida" > `start()`. Idempotent: calling `start()`
   * while already `starting`/`running` is a no-op. On any failure (binary
   * not found, `spawn` throwing synchronously, the child emitting
   * `'error'` or exiting with a failing code within the confirmation
   * window), resolves normally after logging and transitioning to
   * `unavailable` — never throws.
   */
  async start(): Promise<void> {
    if (this.state === 'starting' || this.state === 'running') {
      return;
    }

    // Covers both an explicit manual `start()` call from `unavailable`
    // (design.md: "unavailable --start()--> starting // permite
    // reintentar manualmente") and this same call originating from the
    // background retry timer itself (`scheduleRetry()`'s callback) — in
    // either case, exactly one `start()` attempt is now underway, so any
    // separately pending retry becomes redundant and must not also fire
    // later on top of whatever this attempt lands on.
    this.cancelRetryTimer();

    this.state = 'starting';

    let server: LocalMascotServer | undefined;
    let child: ChildProcess | undefined;

    try {
      server = this.createServerFn();
      const { port } = await server.start(this.preferredPort);

      const mainScriptPath = resolveMainScriptPath(this.desktopMascotDir);

      child = this.spawnElectronProcessFn(this.desktopMascotDir, [mainScriptPath, `--port=${port}`]);
      const outcome = await waitForEarlyChildFailure(child, this.startupConfirmWindowMs);
      if (outcome === 'failed') {
        throw new Error('El proceso Electron de la mascota terminó o emitió un error durante el arranque.');
      }

      this.server = server;
      this.childProcess = child;
      this.attachPostStartupGuards(child);
      this.state = 'running';
    } catch (err) {
      logMascotManagerError('Fallo al iniciar la mascota de escritorio; se continúa sin ella', err);
      await this.cleanupAfterFailedStart(server, child);
      this.state = 'unavailable';
      this.scheduleRetry();
    }
  }

  // -------------------------------------------------------------------
  // Background retry while unavailable (requirements.md 8.3)
  // -------------------------------------------------------------------

  /**
   * Schedules exactly one background retry of `start()`, `retryIntervalMs`
   * from now, per requirements.md 8.3 ("THE DesktopMascotManager SHALL
   * reintentar periódicamente la conexión con App_Electron a lo largo de
   * la sesión en lugar de deshabilitar la funcionalidad de forma
   * permanente"). Deliberately schedules only a single timer rather than
   * a `setInterval`: `start()` itself re-schedules the next retry (via
   * this same method) each time it fails again, which keeps there being
   * at most one pending timer at any moment and means a successful retry
   * naturally stops the chain without any extra bookkeeping beyond the
   * `state !== 'unavailable'` guard below.
   */
  private scheduleRetry(): void {
    this.cancelRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      // Guard against a stale timer firing after the manager already
      // left `unavailable` by some other path (e.g. `stop()`/`dispose()`
      // already cancels this timer explicitly, but this check is cheap
      // defense in depth against any future path that doesn't).
      if (this.state !== 'unavailable') {
        return;
      }
      void this.start();
    }, this.retryIntervalMs);
  }

  /**
   * Cancels the pending background retry timer, if any. Safe to call
   * unconditionally (idempotent no-op when no timer is pending). Called
   * from `start()` (a new attempt supersedes any pending retry) and from
   * `stop()`/`dispose()` (design.md > "Limpieza garantizada de recursos"
   * step 1: "Cancelar cualquier timer pendiente" — applies even on the
   * no-op path from `unavailable`, since that state may now have a retry
   * timer running in the background; leaving it running after an
   * explicit `stop()`/`dispose()` would mean the manager keeps trying to
   * start Electron behind the user's back after they deliberately asked
   * it to stop).
   */
  private cancelRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /**
   * Best-effort teardown of whatever partially started (server bound but
   * child spawn failed, or vice versa) when `start()` fails. Never
   * throws: every step logs its own failure and continues to the next.
   */
  private async cleanupAfterFailedStart(
    server: LocalMascotServer | undefined,
    child: ChildProcess | undefined
  ): Promise<void> {
    this.server = undefined;
    this.childProcess = undefined;

    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch (err) {
        logMascotManagerError('Error al terminar el proceso Electron tras un arranque fallido', err);
      }
    }

    if (server) {
      try {
        await server.stop();
      } catch (err) {
        logMascotManagerError('Error al detener el servidor local tras un arranque fallido', err);
      }
    }
  }

  /**
   * Attaches long-lived listeners on the now-confirmed-alive child
   * process, purely for logging and resource-safety. Without an
   * `'error'` listener, an async spawn failure occurring *after* the
   * short confirmation window would surface as an unhandled `'error'`
   * event and crash the extension host — this listener is what keeps
   * that fail-safe for the lifetime of the process, not just during
   * startup. Not a state-machine transition on its own: design.md's
   * state diagram (see this module's doc comment) defines no
   * `running -> unavailable` edge for an unexpected later crash, so this
   * intentionally only logs and clears the stale reference (avoiding a
   * later attempt to signal an already-dead process in `stop()`), which
   * is exactly what task 4.2 ("limpieza garantizada de recursos y
   * reintentos periódicos") builds on.
   */
  private attachPostStartupGuards(child: ChildProcess): void {
    child.on('error', (err) => {
      logMascotManagerError('El proceso Electron de la mascota emitió un error en ejecución', err);
    });
    child.on('exit', (code, signal) => {
      logMascotManagerError(
        `El proceso Electron de la mascota terminó inesperadamente (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      );
      if (this.childProcess === child) {
        this.childProcess = undefined;
      }
    });
  }

  // -------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------

  /**
   * design.md > "Ciclo de vida" > `stop()`. Idempotent no-op from
   * `idle`/`stopped`/`unavailable` (per the invariant, none of those
   * states hold a live server/child to tear down). From `running`,
   * transitions through `stopping` to `stopped`, terminating the child
   * process (`SIGTERM`, then `SIGKILL` after a grace period) and closing
   * the local server.
   */
  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped' || this.state === 'unavailable') {
      // `unavailable` may have a background retry of `start()` pending
      // (see `scheduleRetry()`); an explicit stop()/dispose() must cancel
      // it even though the rest of this no-op path is otherwise a true
      // no-op (per the class invariant: none of idle/stopped/unavailable
      // hold a live server/child to tear down). Without this, the
      // manager would keep silently trying to start Electron in the
      // background after the user deliberately asked it to stop.
      this.cancelRetryTimer();
      return;
    }

    // Cancel first, per design.md > "Limpieza garantizada de recursos"
    // step 1 ("Cancelar cualquier timer pendiente"). Reaching `stopping`
    // only happens from `running`, which never has a retry timer pending
    // (retries are only ever scheduled while `unavailable`), but calling
    // this unconditionally keeps the ordering explicit and correct even
    // if that invariant ever changes.
    this.cancelRetryTimer();

    this.state = 'stopping';

    await this.terminateChildProcess();
    await this.stopServer();

    this.state = 'stopped';
  }

  /**
   * design.md > "Limpieza garantizada de recursos": `SIGTERM`, wait for
   * `'exit'` up to `stopGraceTimeoutMs`, escalate to `SIGKILL` if it
   * hasn't exited by then. Resolves once the process has actually
   * exited; never rejects.
   */
  private terminateChildProcess(): Promise<void> {
    const child = this.childProcess;
    this.childProcess = undefined;

    if (!child || child.exitCode !== null || child.killed) {
      // Already gone (or never existed) — nothing to wait for.
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;

      const onExit = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(graceTimer);
        resolve();
      };

      child.once('exit', onExit);

      try {
        child.kill('SIGTERM');
      } catch (err) {
        logMascotManagerError('Error al enviar SIGTERM al proceso Electron de la mascota', err);
      }

      const graceTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        try {
          child.kill('SIGKILL');
        } catch (err) {
          logMascotManagerError('Error al enviar SIGKILL al proceso Electron de la mascota', err);
        }
      }, this.stopGraceTimeoutMs);
    });
  }

  /** Closes the local server, if any. Logs instead of throwing on failure. */
  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;

    if (!server) {
      return;
    }

    try {
      await server.stop();
    } catch (err) {
      logMascotManagerError('Error al detener el servidor local de la mascota', err);
    }
  }

  // -------------------------------------------------------------------
  // show() / hide()
  // -------------------------------------------------------------------

  /** design.md > "Ciclo de vida" > `show()`: equivalent to `send({ type: 'show' })`. */
  async show(): Promise<void> {
    await this.send({ type: 'show' });
  }

  /** design.md > "Ciclo de vida" > `hide()`: equivalent to `send({ type: 'hide' })`. */
  async hide(): Promise<void> {
    await this.send({ type: 'hide' });
  }

  // -------------------------------------------------------------------
  // send(event)
  // -------------------------------------------------------------------

  /**
   * design.md > "Ciclo de vida" > `send(event)`. Validates `event` with
   * `isMascotEvent` as defense in depth (never trusts the caller, even
   * internal callers within the extension). Only has an effect while
   * `running`; in any other state it resolves without effect. Never
   * throws and never blocks the caller on a slow/failing broadcast.
   */
  async send(event: MascotEvent): Promise<void> {
    if (!isMascotEvent(event)) {
      logMascotManagerError('DesktopMascotManager.send() recibió un MascotEvent inválido; descartado');
      return;
    }

    if (this.state !== 'running' || !this.server) {
      return;
    }

    try {
      this.server.broadcast(event);
    } catch (err) {
      logMascotManagerError('Error al difundir un MascotEvent a la mascota de escritorio', err);
    }
  }

  // -------------------------------------------------------------------
  // dispose()
  // -------------------------------------------------------------------

  /**
   * design.md > "Ciclo de vida" > `dispose()`. For this task, equivalent
   * to `stop()` (releasing Event Bus listeners registered by
   * `wireDesktopMascotToEventBus` lands in task 13). Safe to call
   * multiple times, same as `stop()`.
   */
  async dispose(): Promise<void> {
    await this.stop();
  }
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the absolute path to the `desktop-mascot/` package directory
 * from this module's own compiled location. At runtime this file lives
 * at `out/src/services/desktop-mascot-manager.js`, so three levels up
 * (`services` -> `src` -> `out`) reaches the repository root, next to
 * `desktop-mascot/`. Built exclusively with `path.join` (requirements.md
 * 9.6: "SHALL construir toda ruta de archivo usando `path.join`, y SHALL
 * NOT construir rutas mediante concatenación manual de cadenas de texto").
 */
function resolveDefaultDesktopMascotDir(): string {
  return path.join(__dirname, '..', '..', '..', 'desktop-mascot');
}

/**
 * Resolves the absolute path to the Electron binary inside
 * `desktop-mascot/node_modules/electron`.
 *
 * Uses the officially documented behavior of the `electron` npm package:
 * when `require()`d from a plain Node.js context (as is the case here —
 * the extension host runs on Node, never on Electron itself), the
 * package's main export is a *string* containing the absolute path to
 * the platform-specific Electron executable, not the Electron API. This
 * is the same mechanism tools like `electron-builder` rely on, and it
 * avoids manually re-deriving the platform-specific executable location
 * inside `electron/dist/` (`electron.exe` on Windows,
 * `Electron.app/Contents/MacOS/Electron` on macOS, `electron` on Linux) —
 * that derivation is exactly what this small package already does
 * internally, so duplicating it here would just be a second place for it
 * to go stale.
 *
 * Deliberately resolved via `require(path.join(...))` (an absolute path)
 * rather than a bare `require('electron')`, so this always resolves
 * `desktop-mascot/`'s own installed copy regardless of the extension's
 * own `node_modules` layout. If the package is missing or its export
 * isn't the expected string (e.g. Electron was never installed via
 * `npm run mascot:install`), this throws — which `start()` catches and
 * turns into the fail-safe `unavailable` transition, never an unhandled
 * exception.
 */
function resolveElectronBinaryPath(desktopMascotDir: string): string {
  const electronPackageDir = path.join(desktopMascotDir, 'node_modules', 'electron');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const resolved: unknown = require(electronPackageDir);
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error(
      `El paquete "electron" en "${electronPackageDir}" no devolvió una ruta de binario válida. ` +
        '¿Se ejecutó "npm run mascot:install"?'
    );
  }
  return resolved;
}

/**
 * Resolves the absolute path to the compiled Electron entry point. Per
 * `desktop-mascot/tsconfig.json` (`rootDir: ".."`, i.e. the repository
 * root), `desktop-mascot/src/main.ts` compiles to
 * `desktop-mascot/dist/desktop-mascot/src/main.js` — matching
 * `desktop-mascot/package.json`'s own `"main"` field
 * (`"dist/desktop-mascot/src/main.js"`).
 */
function resolveMainScriptPath(desktopMascotDir: string): string {
  return path.join(desktopMascotDir, 'dist', 'desktop-mascot', 'src', 'main.js');
}

// ---------------------------------------------------------------------------
// Child process helpers
// ---------------------------------------------------------------------------

/**
 * Default `SpawnElectronProcess`, backed by `child_process.spawn`.
 * Resolves the real Electron binary path (which requires
 * `desktop-mascot/node_modules/electron` to actually exist on disk) only
 * here, at the point of spawning — never at construction time — so that
 * an injected `spawnElectronProcess` test double is never affected by
 * whether Electron happens to be installed.
 */
function defaultSpawnElectronProcess(
  desktopMascotDir: string,
  args: string[]
): ChildProcess {
  const electronBinaryPath =
    resolveElectronBinaryPath(desktopMascotDir);

  const cleanEnvironment = { ...process.env };

  delete cleanEnvironment.ELECTRON_RUN_AS_NODE;
  delete cleanEnvironment.NODE_OPTIONS;

  const child = spawn(electronBinaryPath, args, {
    cwd: desktopMascotDir,
    env: cleanEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (data: Buffer) => {
    console.log(
      `[Pluvianidae Mascot] ${data.toString().trim()}`
    );
  });

  child.stderr?.on('data', (data: Buffer) => {
    console.error(
      `[Pluvianidae Mascot] ${data.toString().trim()}`
    );
  });

  child.on('exit', (code, signal) => {
    console.log(
      `[Pluvianidae Mascot] Electron terminó. Código: ${code}, señal: ${signal}`
    );
  });

  return child;
}

/**
 * See this module's doc comment > "Successful startup simplification".
 * Resolves `'ok'` if `ms` elapses without the child emitting `'error'` or
 * exiting with a non-zero/`null` code; resolves `'failed'` as soon as
 * either happens first. Removes its own listeners once settled so it
 * never leaks a duplicate handler onto the child for the rest of its
 * life (that's `attachPostStartupGuards`'s job, added only after this
 * resolves `'ok'`).
 */
function waitForEarlyChildFailure(child: ChildProcess, ms: number): Promise<'ok' | 'failed'> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (outcome: 'ok' | 'failed'): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      resolve(outcome);
    };

    const onError = (): void => settle('failed');
    const onExit = (code: number | null): void => settle(code === 0 ? 'ok' : 'failed');

    child.once('error', onError);
    child.once('exit', onExit);

    const timer = setTimeout(() => settle('ok'), ms);
  });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Logs a manager-level failure. Mirrors `local-mascot-server.ts`'s
 * logging convention (`console.error` with a `[Pluvianidae]` prefix) —
 * `extension.ts` is responsible for surfacing this to its own
 * `OutputChannel` if/when it wires one up for the mascot (out of scope
 * for this task; see tasks.md 13).
 */
function logMascotManagerError(message: string, err?: unknown): void {
  const suffix = err === undefined ? '' : `: ${err instanceof Error ? err.message : String(err)}`;
  // eslint-disable-next-line no-console
  console.error(`[Pluvianidae] ${message}${suffix}`);
}
