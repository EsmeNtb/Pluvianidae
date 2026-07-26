/**
 * Local Mascot Server (`src/services/local-mascot-server.ts`).
 *
 * Implements design.md > "Componente 2: `LocalMascotServer`" and the
 * "Protocolo de comunicación" section: a plain `http.Server` (Node's
 * built-in `http` module, no `ws` or other new dependency) that serves
 * two endpoints to the standalone Electron desktop mascot app:
 *
 *   - `GET /events`  — Server-Sent Events stream of `MascotEvent`
 *     (extensión → mascota). Each event is written as
 *     `"data: " + JSON.stringify(event) + "\n\n"`.
 *   - `POST /actions` — single JSON `MascotAction` body per request
 *     (mascota → extensión).
 *
 * This module knows nothing about Electron or the extension's business
 * logic (dispatching commands, etc.) — it only owns the HTTP/SSE
 * transport and message validation, matching design.md's stated
 * responsibility for this component: "Escuchar exclusivamente en
 * 127.0.0.1. Autodetectar puerto libre ante EADDRINUSE. Validar cada
 * mensaje entrante/saliente con los type guards de `shared/`."
 *
 * Neither direction ever trusts the other process: every outgoing
 * `broadcast()` call is re-validated with `isMascotEvent` before being
 * written to the wire, and every incoming `POST /actions` body is parsed
 * and validated with `deserializeMascotAction` before being handed to any
 * registered `onAction` handler. Invalid messages are logged and dropped;
 * they never throw an unhandled exception and never close the server or
 * an open SSE connection (design.md: "descartar mensaje, loggear, seguir").
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { MascotEvent, isMascotEvent, serializeMascotEvent } from '../../shared/mascot-events';
import { MascotAction, deserializeMascotAction } from '../../shared/mascot-actions';

// ---------------------------------------------------------------------------
// Public interface (design.md > "Componente 2: LocalMascotServer")
// ---------------------------------------------------------------------------

/** Minimal `Disposable` shape, matching design.md's `Disposable = { dispose(): void }`. */
export interface Disposable {
  dispose(): void;
}

export interface LocalMascotServer {
  /**
   * Starts listening for connections and resolves once the server is
   * actually listening. See `startLocalMascotServer` below for the exact
   * port-selection algorithm (preferred port, falling back to an
   * OS-assigned one on `EADDRINUSE`). Idempotent: calling `start()` again
   * while already listening returns the already-bound port without
   * creating a second server.
   */
  start(preferredPort: number): Promise<{ port: number }>;
  /**
   * Validates `event` with `isMascotEvent` and, if valid, writes it as an
   * SSE message to every currently connected `/events` client. Silently
   * drops (and logs) an invalid event instead of throwing.
   */
  broadcast(event: MascotEvent): void;
  /**
   * Registers `handler` to be invoked for every valid `MascotAction`
   * received on `POST /actions`. Returns a `Disposable` that unregisters
   * `handler`; multiple handlers may be registered at once.
   */
  onAction(handler: (action: MascotAction) => void): Disposable;
  /**
   * Closes the server and every open SSE connection. Resolves once the
   * underlying `http.Server` has finished closing; never rejects (a
   * failure while closing is logged, not thrown — this is a cleanup path).
   */
  stop(): Promise<void>;
}

/** Creates a fresh, not-yet-started `LocalMascotServer`. */
export function createLocalMascotServer(): LocalMascotServer {
  return new HttpLocalMascotServer();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The one and only interface this server is allowed to bind to. See the
 * `SECURITY` comment next to the `listen()` call below — this must never
 * be changed to `'0.0.0.0'` or omitted.
 */
const MASCOT_SERVER_HOST = '127.0.0.1';

const MASCOT_EVENTS_PATH = '/events';
const MASCOT_ACTIONS_PATH = '/actions';

/**
 * Every `MascotAction` is a closed, parameter-free atom (see
 * `shared/mascot-actions.ts`), so a legitimate request body is always
 * tiny. This caps how much of a `POST /actions` body is buffered before
 * the request is rejected with `413`, as a defensive limit against a
 * misbehaving or malicious sender — not a realistic size for any valid
 * message.
 */
const MAX_ACTION_BODY_BYTES = 8192;

// ---------------------------------------------------------------------------
// Port-selection algorithm (design.md > "Protocolo de comunicación" >
// "ALGORITHM startLocalMascotServer(preferredPort)")
// ---------------------------------------------------------------------------

/**
 * Binds `server` to `127.0.0.1`, trying `preferredPort` first. If that
 * port is already in use (`EADDRINUSE`), retries exactly once with port
 * `0` (the OS assigns any free port) — this never loops retrying the same
 * port, matching design.md's algorithm precisely. Resolves with the
 * actual port the server ended up listening on.
 *
 * Adapted from design.md's pseudocode `ALGORITHM
 * startLocalMascotServer(preferredPort)`: that pseudocode creates the
 * `http.Server` itself, whereas here the caller passes an already
 * constructed `server` (with its request handler already wired) so the
 * routing logic stays inside `HttpLocalMascotServer` rather than this
 * free function.
 */
export async function startLocalMascotServer(server: http.Server, preferredPort: number): Promise<number> {
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
    throw new RangeError(`preferredPort debe ser un entero entre 0 y 65535 (recibido: ${preferredPort}).`);
  }

  try {
    return await listenOnPort(server, preferredPort);
  } catch (err) {
    if (preferredPort !== 0 && isAddressInUseError(err)) {
      // Puerto ocupado, probablemente por otra ventana de VS Code con
      // Pluvianidae activo -> pedir uno libre al SO. Se reintenta
      // exactamente una vez, nunca en bucle sobre el mismo puerto.
      return listenOnPort(server, 0);
    }
    throw err;
  }
}

function listenOnPort(server: http.Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);

    // SECURITY: bind exclusively to the loopback interface. Never change
    // this to '0.0.0.0' or omit the host argument — doing so would expose
    // this HTTP server (including the unauthenticated POST /actions
    // endpoint) to every other device on the local network. Per design.md
    // > "Protocolo de comunicación": "escuchando exclusivamente en
    // 127.0.0.1".
    server.listen(port, MASCOT_SERVER_HOST);
  });
}

function isAddressInUseError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

// ---------------------------------------------------------------------------
// HttpLocalMascotServer — http.Server-backed LocalMascotServer
// ---------------------------------------------------------------------------

/**
 * Implements `LocalMascotServer` on top of Node's native `http` module.
 * Owns exactly three pieces of mutable state: the underlying
 * `http.Server`/bound port, the set of currently connected `/events` SSE
 * clients, and the set of registered `onAction` handlers.
 */
class HttpLocalMascotServer implements LocalMascotServer {
  private server: http.Server | undefined;
  private port: number | undefined;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly actionHandlers = new Set<(action: MascotAction) => void>();

  async start(preferredPort: number): Promise<{ port: number }> {
    if (this.server && this.port !== undefined) {
      // Idempotent: a second start() call while already listening reuses
      // the existing server instead of creating (and leaking) another one.
      return { port: this.port };
    }

    const server = http.createServer((req, res) => this.handleRequest(req, res));
    const port = await startLocalMascotServer(server, preferredPort);

    this.server = server;
    this.port = port;
    return { port };
  }

  broadcast(event: MascotEvent): void {
    if (!isMascotEvent(event)) {
      // Defense in depth: never trust the caller, even internally (see
      // shared/mascot-events.ts's isMascotEvent doc comment). A malformed
      // event never reaches an SSE client — it's dropped and logged.
      // eslint-disable-next-line no-console
      console.error('[Pluvianidae] LocalMascotServer.broadcast() recibió un MascotEvent inválido; descartado.', event);
      return;
    }

    const payload = `data: ${serializeMascotEvent(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch (err) {
        // A client can disconnect between the last `close` event tick and
        // this write (e.g. the Electron process was killed mid-write). A
        // failed write must never take down the rest of the broadcast loop
        // or the server itself — drop this client and keep going.
        // eslint-disable-next-line no-console
        console.error(
          `[Pluvianidae] Error al escribir un MascotEvent a un cliente SSE; cliente eliminado: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        this.clients.delete(client);
      }
    }
  }

  onAction(handler: (action: MascotAction) => void): Disposable {
    this.actionHandlers.add(handler);
    return {
      dispose: () => {
        this.actionHandlers.delete(handler);
      },
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;

    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();

    if (!server) {
      return;
    }

    return new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          // Cleanup path: never reject, just log. Mirrors the fail-safe
          // philosophy the rest of this feature uses for teardown.
          // eslint-disable-next-line no-console
          console.error(`[Pluvianidae] Error al cerrar el servidor local de la mascota: ${err.message}`);
        }
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestPath = (req.url ?? '').split('?')[0];

    if (req.method === 'GET' && requestPath === MASCOT_EVENTS_PATH) {
      this.handleEventsRequest(req, res);
      return;
    }

    if (req.method === 'POST' && requestPath === MASCOT_ACTIONS_PATH) {
      this.handleActionsRequest(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /** `GET /events` — opens an SSE stream and keeps `res` open until the client disconnects. */
  private handleEventsRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Node buffers response headers until the first `write()`/`end()` call
    // unless explicitly flushed. Without this, a connecting SSE client
    // (see `desktop-mascot/src/sse-client.ts`'s `maintainConnection`,
    // which resets its heartbeat as soon as the HTTP response arrives)
    // would never observe the connection as established until the first
    // `broadcast()` call — potentially never, if no event is ever sent.
    res.flushHeaders();

    this.clients.add(res);
    req.on('close', () => {
      this.clients.delete(res);
    });
    // A write can fail asynchronously (e.g. the underlying socket resets
    // mid-flush) after `client.write()` in `broadcast()` already returned
    // successfully. Without this listener, that failure would surface as
    // an unhandled `'error'` event and crash the extension host process.
    // Treat it the same as a disconnect: drop the client, log, keep serving
    // everyone else.
    res.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[Pluvianidae] Conexión SSE de cliente cerrada por error; cliente eliminado: ${err.message}`);
      this.clients.delete(res);
    });
  }

  /**
   * `POST /actions` — reads the full body, validates it with
   * `deserializeMascotAction` (JSON parse + `isMascotAction` type guard),
   * and either dispatches it to every registered handler (`204`) or
   * discards it with a logged error (`400`). Never throws: a malformed
   * body is a normal, expected occurrence on an unauthenticated local
   * endpoint, not a server error.
   */
  private handleActionsRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    let rejected = false;

    req.on('data', (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      body += chunk.toString('utf-8');
      if (body.length > MAX_ACTION_BODY_BYTES) {
        rejected = true;
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Payload Too Large');
        req.destroy();
      }
    });

    req.on('end', () => {
      if (rejected) {
        return;
      }

      const action = deserializeMascotAction(body);
      if (action === undefined) {
        // eslint-disable-next-line no-console
        console.error('[Pluvianidae] POST /actions recibió un mensaje inválido o malformado; descartado.');
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      for (const handler of this.actionHandlers) {
        handler(action);
      }
      res.writeHead(204);
      res.end();
    });

    req.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[Pluvianidae] Error leyendo el cuerpo de POST /actions: ${err.message}`);
    });
  }
}
