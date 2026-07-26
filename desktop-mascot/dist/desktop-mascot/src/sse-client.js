"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.maintainConnection = exports.parseSseBuffer = exports.computeNextBackoff = exports.HEARTBEAT_TIMEOUT_MS = exports.MAX_BACKOFF_MS = exports.INITIAL_BACKOFF_MS = void 0;
const http = __importStar(require("http"));
const mascot_events_1 = require("../../shared/mascot-events");
// ---------------------------------------------------------------------------
// Constantes de backoff (design.md > "ALGORITHM maintainConnection")
// ---------------------------------------------------------------------------
/** Backoff inicial (ms) tras la primera desconexión/fallo de conexión. */
exports.INITIAL_BACKOFF_MS = 500;
/** Tope superior (ms) del backoff exponencial: nunca se espera más que esto. */
exports.MAX_BACKOFF_MS = 10000;
// ---------------------------------------------------------------------------
// Constante de heartbeat (design.md > "Limpieza garantizada de recursos")
// ---------------------------------------------------------------------------
/**
 * Tiempo máximo (ms) sin recibir ningún `MascotEvent` válido *ni* lograr
 * una reconexión HTTP exitosa antes de asumir que la extensión ya no
 * existe del otro lado y disparar `onHeartbeatTimeout`. Valor sugerido por
 * design.md.
 */
exports.HEARTBEAT_TIMEOUT_MS = 30000;
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
function computeNextBackoff(currentBackoffMs, maxBackoffMs = exports.MAX_BACKOFF_MS) {
    return Math.min(currentBackoffMs * 2, maxBackoffMs);
}
exports.computeNextBackoff = computeNextBackoff;
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
function parseSseBuffer(buffer) {
    const blocks = buffer.split('\n\n');
    // El último elemento es siempre el resto incompleto (o una cadena vacía
    // si `buffer` terminaba exactamente en un separador `\n\n`), nunca un
    // bloque completo — por eso se extrae con pop() antes de procesar el resto.
    const remainder = blocks.pop() ?? '';
    const events = [];
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
exports.parseSseBuffer = parseSseBuffer;
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
function maintainConnection(options) {
    const { port, onMascotEvent } = options;
    const initialBackoffMs = options.initialBackoffMs ?? exports.INITIAL_BACKOFF_MS;
    const maxBackoffMs = options.maxBackoffMs ?? exports.MAX_BACKOFF_MS;
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? exports.HEARTBEAT_TIMEOUT_MS;
    let backoffMs = initialBackoffMs;
    let stopped = false;
    let retryTimer;
    let activeRequest;
    let heartbeatTimer;
    // ---------------------------------------------------------------------
    // Heartbeat de autoterminación (tarea 7.2, design.md > "Limpieza
    // garantizada de recursos"). Se reinicia (reset de la cuenta atrás) en
    // cualquiera de las dos señales de vida documentadas: un evento válido
    // recibido, o una reconexión HTTP exitosa (el servidor respondió 200 y
    // comenzó el stream), incluso si todavía no llegó ningún evento tras
    // ella. Si vence sin que ninguna de las dos señales lo reinicie, se
    // asume que la extensión ya no existe del otro lado.
    // ---------------------------------------------------------------------
    function resetHeartbeat() {
        if (stopped) {
            return;
        }
        if (heartbeatTimer !== undefined) {
            clearTimeout(heartbeatTimer);
        }
        heartbeatTimer = setTimeout(() => {
            heartbeatTimer = undefined;
            // eslint-disable-next-line no-console
            console.error(`[sse-client] Heartbeat vencido: ${heartbeatTimeoutMs}ms sin eventos ni reconexión exitosa ` +
                `(puerto ${port}). Asumiendo que la extensión ya no existe.`);
            options.onHeartbeatTimeout?.();
        }, heartbeatTimeoutMs);
    }
    function clearHeartbeat() {
        if (heartbeatTimer !== undefined) {
            clearTimeout(heartbeatTimer);
            heartbeatTimer = undefined;
        }
    }
    function scheduleRetry() {
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
    function connect() {
        if (stopped) {
            return;
        }
        let buffer = '';
        // Una conexión puede fallar por más de una vía a la vez (p. ej. el
        // socket se resetea, disparando tanto 'error' en el response como
        // 'error' en el request). `finished` evita programar dos reintentos
        // para el mismo intento de conexión.
        let finished = false;
        const onConnectionFailure = (err) => {
            if (finished) {
                return;
            }
            finished = true;
            activeRequest = undefined;
            // CATCH connectionError -> log(connectionError); nunca relanzar: una
            // caída de conexión jamás debe escapar del bucle de reintentos.
            // eslint-disable-next-line no-console
            console.error(`[sse-client] Conexión SSE perdida o fallida (puerto ${port}): ${err instanceof Error ? err.message : String(err)}`);
            scheduleRetry();
        };
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/events',
            method: 'GET',
            headers: { Accept: 'text/event-stream' },
        }, (res) => {
            if (res.statusCode !== 200) {
                onConnectionFailure(new Error(`Respuesta inesperada del servidor: HTTP ${res.statusCode}`));
                res.resume(); // drenar y descartar el cuerpo de la respuesta
                return;
            }
            // Señal de vida #1: reconexión HTTP exitosa (200 + comienzo del
            // stream), aunque todavía no haya llegado ningún evento tras ella.
            resetHeartbeat();
            res.setEncoding('utf-8');
            res.on('data', (chunk) => {
                buffer += chunk;
                const parsed = parseSseBuffer(buffer);
                buffer = parsed.remainder;
                for (const rawData of parsed.events) {
                    const event = (0, mascot_events_1.deserializeMascotEvent)(rawData);
                    if (event !== undefined) {
                        // éxito -> resetear backoff (ver pseudocódigo ON eachEvent)
                        backoffMs = initialBackoffMs;
                        // Señal de vida #2: evento válido recibido.
                        resetHeartbeat();
                        onMascotEvent(event);
                    }
                    else {
                        // descartar mensaje inválido, loggear, SEGUIR (nunca cerrar
                        // el bucle de reconexión por esto).
                        // eslint-disable-next-line no-console
                        console.error('[sse-client] Evento SSE inválido o malformado descartado:', rawData);
                    }
                }
            });
            res.on('end', () => onConnectionFailure(new Error('El servidor cerró la conexión SSE')));
            res.on('error', onConnectionFailure);
        });
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
        stop() {
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
exports.maintainConnection = maintainConnection;
//# sourceMappingURL=sse-client.js.map