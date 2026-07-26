import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import fc from 'fast-check';
import { createLocalMascotServer, type LocalMascotServer } from '../../src/services/local-mascot-server';
import { deserializeMascotEvent, type MascotEvent } from '../../shared/mascot-events';
import { deserializeMascotAction } from '../../shared/mascot-actions';

// Feature: desktop-mascot, tasks.md 3.3 — pruebas de propiedad y unitarias
// para `LocalMascotServer` (`src/services/local-mascot-server.ts`).
//
// Property 1: Rechazo seguro de mensajes inválidos — para cualquier
// mensaje `raw: string` recibido en /actions, si `deserializeMascotAction`
// retorna `undefined`, el mensaje SHALL ser descartado y loggeado, y la
// conexión/servidor SHALL permanecer disponible para peticiones futuras.
//
// Property 2: Orden y no pérdida de eventos difundidos — para cualquier
// secuencia de `MascotEvent` enviados por `broadcast(...)` mientras hay un
// cliente SSE conectado, cada evento SHALL llegar exactamente una vez y en
// el mismo orden de emisión.
//
// **Validates: Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 12.1, 12.3**
//
// Ambas pruebas de propiedad usan un `LocalMascotServer` real escuchando en
// un puerto efímero (127.0.0.1) y un cliente HTTP de prueba minimal
// construido con `http.request`, en vez de mocks: la propia forma en que
// se serializan/parsean los mensajes SSE y las respuestas HTTP es parte de
// lo que se quiere validar.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal SSE test client for `GET /events`, analogous to what
 * `desktop-mascot/src/sse-client.ts` does with `http.request` (see
 * design.md > "Protocolo de comunicación"), but simplified: no
 * reconnection/backoff logic, just accumulate every validated
 * `MascotEvent` received, in arrival order.
 */
function connectSseClient(port: number): {
  received: MascotEvent[];
  close: () => void;
  ready: Promise<void>;
} {
  const received: MascotEvent[] = [];
  let buffer = '';
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const req = http.request(
    { host: '127.0.0.1', port, path: '/events', method: 'GET' },
    (res) => {
      resolveReady();
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawMessage = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const dataLine = rawMessage.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine !== undefined) {
            const event = deserializeMascotEvent(dataLine.slice('data: '.length));
            if (event !== undefined) {
              received.push(event);
            }
          }
        }
      });
    },
  );
  // Torn down on purpose at the end of each test via `close()` (which calls
  // `req.destroy()`); that legitimately raises a socket-hang-up-style
  // error on some platforms, which must never fail the test.
  req.on('error', () => {});
  req.end();

  return { received, close: () => req.destroy(), ready };
}

/** Minimal `POST /actions` test client, returning just the status code. */
function postAction(port: number, body: string): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/actions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Polls `predicate` until it's true or `timeoutMs` elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Arbitrary generating every valid `MascotEvent` variant (mirrors `isMascotEvent`'s allowed shapes). */
const mascotEventArbitrary: fc.Arbitrary<MascotEvent> = fc.oneof(
  fc.constant<MascotEvent>({ type: 'idle' }),
  fc.constant<MascotEvent>({ type: 'hide' }),
  fc.constant<MascotEvent>({ type: 'show' }),
  fc.oneof(
    fc.constant<MascotEvent>({ type: 'indexing' }),
    fc.record({
      type: fc.constant<'indexing'>('indexing'),
      file: fc.string({ minLength: 1, maxLength: 50 }),
    }),
    fc.record({
      type: fc.constant<'indexing'>('indexing'),
      progress: fc.integer({ min: 0, max: 100 }),
    }),
    fc.record({
      type: fc.constant<'indexing'>('indexing'),
      file: fc.string({ minLength: 1, maxLength: 50 }),
      progress: fc.integer({ min: 0, max: 100 }),
    }),
  ),
  fc.record({
    type: fc.constant<'success'>('success'),
    message: fc.string({ minLength: 1, maxLength: 100 }),
  }),
  fc.record({
    type: fc.constant<'warning'>('warning'),
    message: fc.string({ minLength: 1, maxLength: 100 }),
  }),
  fc.record({
    type: fc.constant<'error'>('error'),
    message: fc.string({ minLength: 1, maxLength: 100 }),
  }),
  fc.record({
    type: fc.constant<'seed'>('seed'),
    amount: fc.integer({ min: 1, max: 1000 }),
  }),
);

// ---------------------------------------------------------------------------
// Property 2: Orden y no pérdida de eventos difundidos
// ---------------------------------------------------------------------------

describe('LocalMascotServer property tests', () => {
  describe('Property 2: Orden y no pérdida de eventos difundidos', () => {
    let server: LocalMascotServer;
    let port: number;
    let sseClient: ReturnType<typeof connectSseClient>;

    beforeEach(async () => {
      server = createLocalMascotServer();
      const result = await server.start(0);
      port = result.port;
      sseClient = connectSseClient(port);
      await sseClient.ready;
      // Give the server's `req.on('close', ...)`/client-registration a tick
      // to settle before the property starts broadcasting.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    afterEach(async () => {
      sseClient.close();
      await server.stop();
    });

    it('para cualquier secuencia de MascotEvent, cada evento llega exactamente una vez y en el mismo orden de emisión', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(mascotEventArbitrary, { minLength: 1, maxLength: 8 }),
          async (events) => {
            sseClient.received.length = 0;

            for (const event of events) {
              server.broadcast(event);
            }

            await waitUntil(() => sseClient.received.length >= events.length, 2000, 5);
            expect(sseClient.received).toEqual(events);
          },
        ),
        { numRuns: 15 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 1: Rechazo seguro de mensajes inválidos (lado POST /actions)
  // -------------------------------------------------------------------------

  describe('Property 1: Rechazo seguro de mensajes inválidos en POST /actions', () => {
    let server: LocalMascotServer;
    let port: number;

    beforeEach(async () => {
      server = createLocalMascotServer();
      const result = await server.start(0);
      port = result.port;
    });

    afterEach(async () => {
      await server.stop();
    });

    it('para cualquier raw inválido (JSON malformado o JSON válido de forma incorrecta), la petición es rechazada con 400 y el servidor sigue respondiendo', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string().filter((raw) => deserializeMascotAction(raw) === undefined),
          async (raw) => {
            const rejected = await postAction(port, raw);
            expect(rejected.statusCode).toBe(400);

            // El servidor SHALL seguir respondiendo a peticiones posteriores:
            // una petición válida inmediatamente después debe tener éxito.
            const followUp = await postAction(port, JSON.stringify({ action: 'hide-mascot' }));
            expect(followUp.statusCode).toBe(204);
          },
        ),
        { numRuns: 30 },
      );
    });

    it('JSON válido pero con forma incorrecta también es rechazado con 400 sin afectar peticiones subsecuentes', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.integer(),
            fc.string(),
            fc.boolean(),
            fc.array(fc.anything()),
            fc.record({ action: fc.constant('hide-mascot'), extra: fc.string() }),
            fc.record({ action: fc.string().filter((s) => s !== 'hide-mascot') }),
          ),
          async (value) => {
            const raw = JSON.stringify(value);
            const rejected = await postAction(port, raw);
            expect(rejected.statusCode).toBe(400);

            const followUp = await postAction(port, JSON.stringify({ action: 'close-mascot' }));
            expect(followUp.statusCode).toBe(204);
          },
        ),
        { numRuns: 30 },
      );
    });
  });
});
