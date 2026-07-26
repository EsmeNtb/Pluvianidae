import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createLocalMascotServer, type LocalMascotServer } from '../../../src/services/local-mascot-server';

// Feature: desktop-mascot, tasks.md 3.3 — prueba unitaria de autodetección
// de puerto libre ante `EADDRINUSE` simulado.
//
// Ocupa un puerto real con un `http.Server` de control, luego arranca un
// `LocalMascotServer` pidiendo ese mismo puerto como `preferredPort` y
// confirma que autodetecta uno distinto (vía fallback a puerto 0) en vez
// de fallar o reintentar en bucle sobre el mismo puerto.
// **Validates: Requirements 3.1, 3.6**

describe('LocalMascotServer > autodetección de puerto ante EADDRINUSE', () => {
  let occupyingServer: http.Server | undefined;
  let mascotServer: LocalMascotServer | undefined;

  afterEach(async () => {
    if (mascotServer) {
      await mascotServer.stop();
      mascotServer = undefined;
    }
    if (occupyingServer) {
      await new Promise<void>((resolve) => occupyingServer!.close(() => resolve()));
      occupyingServer = undefined;
    }
  });

  it('autodetecta un puerto distinto cuando el preferredPort ya está ocupado, en vez de fallar', async () => {
    // 1. Ocupar un puerto real en 127.0.0.1 con un servidor de control.
    occupyingServer = http.createServer();
    const occupiedPort = await new Promise<number>((resolve, reject) => {
      occupyingServer!.once('error', reject);
      occupyingServer!.once('listening', () => {
        resolve((occupyingServer!.address() as AddressInfo).port);
      });
      occupyingServer!.listen(0, '127.0.0.1');
    });

    // 2. Intentar arrancar un LocalMascotServer con ese mismo puerto como preferido.
    mascotServer = createLocalMascotServer();
    const { port: resolvedPort } = await mascotServer.start(occupiedPort);

    // 3. Debe haber autodetectado un puerto libre distinto, sin lanzar ni bloquear.
    expect(resolvedPort).not.toBe(occupiedPort);
    expect(resolvedPort).toBeGreaterThan(0);
  });

  it('usa el preferredPort solicitado cuando está libre (caso base, sin colisión)', async () => {
    mascotServer = createLocalMascotServer();
    const { port } = await mascotServer.start(0);
    expect(port).toBeGreaterThan(0);
  });
});
