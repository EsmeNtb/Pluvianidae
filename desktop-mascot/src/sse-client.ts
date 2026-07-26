/**
 * Cliente SSE propio para la mascota de escritorio (tarea 7.1).
 *
 * Ver .kiro/specs/desktop-mascot/design.md > "Protocolo de comunicación" >
 * "Reconexión automática" (`ALGORITHM maintainConnection`) para el
 * pseudocódigo exacto que este módulo implementa.
 *
 * Deliberadamente NO se usa el `EventSource` del navegador/Chromium para
 * conectarse a `GET /events`: se usa `http.request` (módulo `http` nativo
 * de Node) y se parsea el formato `text/event-stream` a mano, para que
 * toda la lógica de reconexión y backoff sea código propio, testeable con
 * Vitest/fast-check sin depender del motor de red de Chromium ni de un
 * `BrowserWindow` real (ver design.md, sección "Transporte elegido").
 *
 * Este archivo separa deliberadamente la lógica pura (`computeNextBackoff`,
 * `parseSseBuffer`) de la lógica con efectos secundarios
 * (`maintainConnection`, que abre sockets y timers reales), siguiendo el
 * mismo patrón que `window-state.ts` (funciones puras + funciones de I/O
 * en el mismo archivo, sin aislamiento adicional artificial) para que la
 * tarea 7.3 (pruebas de propiedad de backoff/parseo) pueda probar ambas
 * funciones puras sin abrir ninguna conexión HTTP real.
 *
 * Implementa también el heartbeat de autoterminación (tarea 7.2): ver
 * design.md > "Limpieza garantizada de recursos" (párrafo del heartbeat):
 * como defensa en profundidad contra procesos Electron huérfanos si la
 * extensión muere sin llamar `dispose()` (p. ej. un crash del proceso de
 * VS Code, que no le da tiempo a la extensión a cerrar limpiamente el
 * servidor local ni el hijo Electron), este módulo mantiene un temporizador
 * de heartbeat: si pasan más de `HEARTBEAT_TIMEOUT_MS` sin recibir ningún
 * evento válido *ni* lograr una reconexión HTTP exitosa, se asume que la
 * extensión ya no existe del otro lado y se invoca `options.onHeartbeatTimeout`
 * (que en `main.ts`, tarea de integración, será `() => app.quit()`).
 */

import * as http from 'http';
import { MascotEvent, deserializeMascotEvent } from '../../shared/mascot-events';

// ---------------------------------------------------------------------------
// Constantes de backoff (design.md > "ALGORITHM maintainConnection")
// ---------------------------------------------------------------------------

/** Backoff inicial (ms) tras la primera desconexión/fallo de conexión. */
export const INITIAL_BACKOFF_MS = 500;

/** Tope superior (ms) del backoff exponencial: nunca se espera más que esto. */
export const MAX_BACKOFF_MS = 10000;

// ---------------------------------------------------------------------------
// Constante de heartbeat (design.md > "Limpieza garantizada de recursos")
// ---------------------------------------------------------------------------

/**
 * Tiempo máximo (ms) sin recibir ningún `MascotEvent` válido *ni* lograr
 * una reconexión HTTP exitosa antes de asumir que la extensión ya no
 * existe del otro lado y disparar `onHeartbeatTimeout`. Valor sugerido por
 * design.md.
 */
export const HEARTBEAT_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Lógica pura: backoff
// ---------------------------------------------------------------------------

/**
 * Calcula el siguiente valor de `backoffMs` tras un fallo de conexión o un
 * cierre de la conexión SSE, siguiendo exactamente el pseudocódigo de
 * design.md: `backoffMs ← min(backoffMs * 2, MAX_BACKOFF_MS)`.
 *
 * Función pura, sin efectos secundarios: no programa ningún `setTimeout`
 * por sí misma (eso es responsabilidad de `maintainConnection`). Esto
 * permite probar la progresión de backoff (p. ej. que siempre queda
 * acotada entre `INITIAL_BACKOFF_MS` y `maxBackoffMs`, y que es monótona no
 * decreciente hasta alcanzar el tope) sin abrir ninguna conexión real.
 */
export function computeNextBackoff(
  currentBackoffMs: number,
  maxBackoffMs: number = MAX_BACKOFF_MS
): number {
  return Math.min(currentBackoffMs * 2, maxBackoffMs);
}

// ---------------------------------------------------------------------------
// Lógica pura: parseo del formato text/event-stream
// ---------------------------------------------------------------------------

/** Resultado de parsear (parcialmente) un buffer SSE acumulado. */
export interface ParsedSseBuffer {
  /**
   * Payloads de datos ya completos (uno por bloque `\n\n` encontrado en el
   * buffer), en el orden en que aparecen. Cada elemento es el contenido
   * crudo tras el prefijo `"data: "` (o `"data:"` sin espacio), listo para
   * pasar a `JSON.parse`/`deserializeMascotEvent`. Si un bloque no contenía
   * ninguna línea `data:` (p. ej. un comentario de keep-alive SSE que
   * empieza con `:`), simplemente no aporta ningún elemento a este array —
   * se descarta silenciosamente, no es un evento inválido.
   */
  events: string[];
  /**
   * El resto del buffer que no forma un bloque completo todavía (no
   * contiene un separador `\n\n` final): debe conservarse y anteponerse al
   * siguiente chunk recibido del socket.
   */
  remainder: string;
}

/**
 * Parsea (posiblemente de forma parcial) un buffer de texto acumulado del
 * stream SSE `GET /events`.
 *
 * Formato producido por el servidor (`local-mascot-server.ts`):
 * `"data: " + JSON.stringify(event) + "\n\n"` por cada evento — es decir,
 * cada mensaje es un único bloque terminado en una línea vacía. Esta
 * función es intencionalmente un poco más permisiva que ese único formato
 * exacto (acepta múltiples líneas `data:` dentro de un mismo bloque,
 * uniéndolas con `\n`, y tolera el prefijo `"data:"` sin espacio) porque es
 * el comportamiento estándar de SSE y no cuesta nada extra soportarlo,
 * pero nunca se generan bloques sintéticos ni se intenta "adivinar" un
 * evento incompleto: sólo se devuelven bloques que ya tienen su separador
 * `\n\n` completo en el buffer.
 *
 * Función pura: no toca ningún socket ni estado externo. `maintainConnection`
 * es responsable de acumular `remainder` entre llamadas sucesivas a medida
 * que llegan más chunks del socket.
 */
export function parseSseBuffer(buffer: string): ParsedSseBuffer {
  const blocks = buffer.split('\n\n');
  // El último elemento es siempre el resto incompleto (o una cadena vacía
  // si `buffer` terminaba exactamente en un separador `\n\n`), nunca un
  // bloque completo — por eso se extrae con pop() antes de procesar el resto.
  const remainder = blocks.pop() ?? '';

  const events: string[] = [];
  for (const block of blocks) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''));

    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'));
    }
  }

  return { events, remainder };
}

// ---------------------------------------------------------------------------
// maintainConnection: efectos secundarios (socket HTTP + timers)
// ---------------------------------------------------------------------------

export interface MaintainConnectionOptions {
  /** Puerto local del servidor de la extensión (`LocalMascotServer`). */
  port: number;
  /** Invocado exactamente una vez por cada `MascotEvent` válido recibido. */
  onMascotEvent: (event: MascotEvent) => void;
  /** Backoff inicial, en ms. Por defecto `INITIAL_BACKOFF_MS`. */
  initialBackoffMs?: number;
  /** Tope superior de backoff, en ms. Por defecto `MAX_BACKOFF_MS`. */
  maxBackoffMs?: number;
  /**
   * Invocado si pasan `heartbeatTimeoutMs` sin recibir ningún evento
   * válido ni lograr una reconexión exitosa. Por defecto, si no se
   * provee, no hace nada especial más allá de loguear (el llamador real,
   * `main.ts`, pasará aquí `() => app.quit()`).
   */
  onHeartbeatTimeout?: () => void;
  /** Timeout de heartbeat, en ms. Por defecto `HEARTBEAT_TIMEOUT_MS`. */
  heartbeatTimeoutMs?: number;
}

/** Controlador devuelto por `maintainConnection` para detener el bucle. */
export interface MaintainConnectionHandle {
  /**
   * Detiene el bucle de reconexión de forma limpia: cancela cualquier
   * timer de backoff pendiente y destruye la conexión HTTP activa (si
   * existe), sin dejar timers ni sockets huérfanos. Tras llamar a `stop()`,
   * ningún nuevo intento de conexión se programa, incluso si la conexión
   * en curso termina o falla justo después.
   */
  stop: () => void;
}

/**
 * Mantiene una conexión SSE contra `http://127.0.0.1:<port>/events`,
 * reconectando indefinidamente con backoff exponencial acotado ante
 * cualquier fallo o cierre de conexión, según
 * `ALGORITHM maintainConnection` en design.md.
 *
 * Elección de diseño (documentada, ver instrucciones de la tarea 7.1): el
 * pseudocódigo de design.md resetea `backoffMs` a `INITIAL_BACKOFF_MS`
 * específicamente al recibir el primer evento *válido* dentro de la rama
 * `ON eachEvent DO ... IF event IS NOT undefined THEN backoffMs ←
 * INITIAL_BACKOFF_MS`, no simplemente al establecer la conexión HTTP. Esta
 * implementación sigue el pseudocódigo literalmente: el backoff sólo se
 * resetea cuando llega un `MascotEvent` válido, no en el momento en que el
 * servidor responde con las cabeceras SSE. Esto evita "resetear
 * prematuramente" el backoff si el servidor acepta la conexión pero nunca
 * llega a emitir ningún evento válido antes de caerse de nuevo.
 *
 * El bucle nunca termina permanentemente por una caída de conexión: no hay
 * ningún `return`/`throw` que escape del ciclo de reconexión; sólo `stop()`
 * detiene definitivamente los reintentos.
 */
export function maintainConnection(options: MaintainConnectionOptions): MaintainConnectionHandle {
  const { port, onMascotEvent } = options;
  const initialBackoffMs = options.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  let backoffMs = initialBackoffMs;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRequest: http.ClientRequest | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------------------------------------------------------------------
  // Heartbeat de autoterminación (tarea 7.2, design.md > "Limpieza
  // garantizada de recursos"). Se reinicia (reset de la cuenta atrás) en
  // cualquiera de las dos señales de vida documentadas: un evento válido
  // recibido, o una reconexión HTTP exitosa (el servidor respondió 200 y
  // comenzó el stream), incluso si todavía no llegó ningún evento tras
  // ella. Si vence sin que ninguna de las dos señales lo reinicie, se
  // asume que la extensión ya no existe del otro lado.
  // ---------------------------------------------------------------------
  function resetHeartbeat(): void {
    if (stopped) {
      return;
    }
    if (heartbeatTimer !== undefined) {
      clearTimeout(heartbeatTimer);
    }
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      // eslint-disable-next-line no-console
      console.error(
        `[sse-client] Heartbeat vencido: ${heartbeatTimeoutMs}ms sin eventos ni reconexión exitosa ` +
          `(puerto ${port}). Asumiendo que la extensión ya no existe.`
      );
      options.onHeartbeatTimeout?.();
    }, heartbeatTimeoutMs);
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function scheduleRetry(): void {
    if (stopped) {
      return;
    }
    // AWAIT sleep(backoffMs); backoffMs ← min(backoffMs * 2, MAX_BACKOFF_MS)
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      backoffMs = computeNextBackoff(backoffMs, maxBackoffMs);
      connect();
    }, backoffMs);
  }

  function connect(): void {
    if (stopped) {
      return;
    }

    let buffer = '';
    // Una conexión puede fallar por más de una vía a la vez (p. ej. el
    // socket se resetea, disparando tanto 'error' en el response como
    // 'error' en el request). `finished` evita programar dos reintentos
    // para el mismo intento de conexión.
    let finished = false;

    const onConnectionFailure = (err: unknown): void => {
      if (finished) {
        return;
      }
      finished = true;
      activeRequest = undefined;
      // CATCH connectionError -> log(connectionError); nunca relanzar: una
      // caída de conexión jamás debe escapar del bucle de reintentos.
      // eslint-disable-next-line no-console
      console.error(
        `[sse-client] Conexión SSE perdida o fallida (puerto ${port}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      scheduleRetry();
    };

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/events',
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          onConnectionFailure(new Error(`Respuesta inesperada del servidor: HTTP ${res.statusCode}`));
          res.resume(); // drenar y descartar el cuerpo de la respuesta
          return;
        }

        // Señal de vida #1: reconexión HTTP exitosa (200 + comienzo del
        // stream), aunque todavía no haya llegado ningún evento tras ella.
        resetHeartbeat();

        res.setEncoding('utf-8');

        res.on('data', (chunk: string) => {
          buffer += chunk;
          const parsed = parseSseBuffer(buffer);
          buffer = parsed.remainder;

          for (const rawData of parsed.events) {
            const event = deserializeMascotEvent(rawData);
            if (event !== undefined) {
              // éxito -> resetear backoff (ver pseudocódigo ON eachEvent)
              backoffMs = initialBackoffMs;
              // Señal de vida #2: evento válido recibido.
              resetHeartbeat();
              onMascotEvent(event);
            } else {
              // descartar mensaje inválido, loggear, SEGUIR (nunca cerrar
              // el bucle de reconexión por esto).
              // eslint-disable-next-line no-console
              console.error('[sse-client] Evento SSE inválido o malformado descartado:', rawData);
            }
          }
        });

        res.on('end', () => onConnectionFailure(new Error('El servidor cerró la conexión SSE')));
        res.on('error', onConnectionFailure);
      }
    );

    req.on('error', onConnectionFailure);

    activeRequest = req;
    req.end();
  }

  // Arranca el heartbeat desde el primer intento de conexión: si la
  // extensión nunca llega a estar disponible (ninguna reconexión tiene
  // éxito y no llega ningún evento), el heartbeat debe poder vencer igual,
  // no sólo tras una primera señal de vida.
  resetHeartbeat();
  connect();

  return {
    stop(): void {
      stopped = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      clearHeartbeat();
      if (activeRequest !== undefined) {
        activeRequest.destroy();
        activeRequest = undefined;
      }
    },
  };
}
