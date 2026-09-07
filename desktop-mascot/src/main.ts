/**
 * Proceso principal de Electron para la mascota de escritorio de Pluvianidae.
 *
 * Ver .kiro/specs/desktop-mascot/design.md > "Ventana Electron" para la
 * configuración exacta de `BrowserWindow` implementada aquí (tarea 5.1).
 *
 * Pendiente en tareas posteriores del plan de implementación:
 * - Tarea 6.3: arrastre de la ventana vía CSS (`-webkit-app-region: drag`).
 * - Tarea 7: `sse-client.ts` (conexión con el servidor local de la extensión).
 *   Esta tarea (8.2) sólo extrae el puerto de `process.argv` para
 *   reutilizarlo aquí y, más adelante, en `sse-client.ts`.
 *
 * Tarea 11.2: "Ocultar mascota" oculta la `BrowserWindow` localmente sin
 * cerrar el proceso; "Cerrar mascota" cierra la ventana e inicia
 * `app.quit()` — ver `applyLocalActionEffect`, invocada desde
 * `processMascotAction`.
 */

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as http from 'http';
import * as path from 'path';
import { isMascotAction, MascotAction } from '../../shared/mascot-actions';
import { buildMascotContextMenu } from './context-menu';
import { MASCOT_ACTION_CHANNEL, MASCOT_EVENT_CHANNEL } from './ipc-channels';
import { maintainConnection, MaintainConnectionHandle } from './sse-client';
import { decideSingleInstanceOutcome } from './single-instance';
import {
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  WindowPosition,
  getWindowPositionFilePath,
  readSavedPosition,
  resolveInitialPosition,
  createDebouncedPositionSaver,
} from './window-state';

/**
 * El mismo host al que se restringe `LocalMascotServer` del lado de la
 * extensión (ver `src/services/local-mascot-server.ts`, `MASCOT_SERVER_HOST`).
 * `main.ts` sólo hace peticiones salientes hacia loopback, nunca hacia
 * ninguna otra interfaz.
 */
const MASCOT_SERVER_HOST = '127.0.0.1';
const MASCOT_ACTIONS_PATH = '/actions';

/**
 * Puerto del servidor local de la extensión, extraído de `process.argv`
 * (argumento `--port=<n>`, ver design.md > "Descubrimiento de puerto").
 * `DesktopMascotManager.start()` ya construye este argumento al spawnear
 * el proceso Electron
 * (`spawnElectronProcess(desktopMascotDir, [mainScriptPath, '--port=' + port])`).
 *
 * Guardado como variable de módulo para que tanto el handler de
 * `MASCOT_ACTION_CHANNEL` (tarea 8.2) como la futura integración de
 * `sse-client.ts` (tarea 7, pendiente de conectar en `main.ts`) reutilicen
 * el mismo valor sin volver a parsear `process.argv`.
 */
const extensionServerPort: number | undefined = parsePortFromArgv(process.argv);

/**
 * Busca un argumento con el prefijo `--port=` en `argv` y devuelve el
 * número que le sigue. Devuelve `undefined` si no hay tal argumento, o si
 * el valor no es un entero válido dentro del rango de puertos TCP — en
 * ambos casos, nunca se lanza una excepción por un argv malformado.
 */
function parsePortFromArgv(argv: string[]): number | undefined {
  const prefix = '--port=';
  const arg = argv.find((entry) => entry.startsWith(prefix));
  if (arg === undefined) {
    return undefined;
  }

  const rawValue = arg.slice(prefix.length);
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

/**
 * Reenvía `action` a la extensión vía `POST /actions` hacia
 * `http://127.0.0.1:<port>/actions` (ver design.md > "Protocolo de
 * comunicación"), usando el módulo `http` nativo de Node (sin
 * dependencias nuevas). Nunca lanza: cualquier error de la petición
 * (extensión no disponible, conexión rechazada, etc.) sólo se loguea con
 * `console.error` — un fallo de comunicación con la extensión nunca debe
 * tumbar el proceso Electron.
 */
function postActionToExtension(port: number, action: MascotAction): void {
  const body = JSON.stringify(action);

  const req = http.request(
    {
      host: MASCOT_SERVER_HOST,
      port,
      path: MASCOT_ACTIONS_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      // Se consume la respuesta para liberar el socket; el resultado no
      // cambia el comportamiento de main.ts (fire-and-forget hacia la
      // extensión), sólo se descarta.
      res.resume();
    }
  );

  req.on('error', (err) => {
    console.error(
      `[Pluvianidae Mascot] Error al reenviar MascotAction a la extensión (POST ${MASCOT_ACTIONS_PATH}): ${err.message}`
    );
  });

  req.write(body);
  req.end();
}

/**
 * Procesa una `MascotAction` ya construida localmente en el proceso main
 * (es decir, que no necesita volver a viajar por el canal IPC
 * renderer->main): reenvía a la extensión vía `postActionToExtension`.
 *
 * Compartida por dos orígenes:
 *   1. El handler de `MASCOT_ACTION_CHANNEL` (tarea 8.2), tras validar con
 *      `isMascotAction` un mensaje llegado del renderer.
 *   2. El `click` de cada entrada del menú contextual (tarea 11.1,
 *      `context-menu.ts`), que ya corre en el proceso main y construye el
 *      `MascotAction` con literales tipados — se revalida aquí de todas
 *      formas con `isMascotAction` como defensa en profundidad, igual que
 *      en el resto del feature (nunca confiar ciegamente ni siquiera en
 *      código propio que cruza un límite de módulo).
 *
 * Tarea 11.2 — comportamiento diferenciado local (además de reenviar):
 *   - `hide-mascot`: oculta la `BrowserWindow` de inmediato (`win.hide()`),
 *     sin destruir la ventana ni terminar el proceso — la app sigue viva,
 *     sólo no visible. Da una respuesta inmediata en la UI sin depender de
 *     esperar a que la extensión responda con `{ type: 'hide' }` de vuelta
 *     (que de todas formas también podría llegar más tarde vía
 *     `sse-client.ts` una vez integrado en la tarea 7 — ocultar una
 *     ventana ya oculta es una operación segura/idempotente en Electron).
 *   - `close-mascot`: inicia el cierre completo del proceso de forma
 *     ordenada: `win.close()` (dispara el evento `'closed'` ya manejado
 *     arriba, que cancela el `positionSaver` pendiente) y `app.quit()`.
 *     El reenvío a la extensión (`postActionToExtension`) es
 *     fire-and-forget vía `http.request`, así que este cierre local se
 *     ejecuta de forma segura incluso si esa petición falla o no responde
 *     a tiempo — no hay ninguna espera ni dependencia entre ambos.
 *
 * Este comportamiento local se implementa aquí, en `processMascotAction`,
 * en vez de en el `click` de `context-menu.ts` o en el handler de
 * `MASCOT_ACTION_CHANNEL` por separado: `processMascotAction` es el punto
 * único de entrada para cualquier `MascotAction` construida localmente en
 * el proceso main (ver los dos orígenes documentados arriba), así que
 * ambos —menú contextual e IPC del renderer— se benefician del mismo
 * comportamiento de forma consistente, sin duplicar la lógica en dos
 * sitios.
 */
function processMascotAction(action: MascotAction): void {
  if (!isMascotAction(action)) {
    console.error('[Pluvianidae Mascot] MascotAction inválida; descartada.', action);
    return;
  }

  if (extensionServerPort === undefined) {
    console.error(
      '[Pluvianidae Mascot] No se pudo reenviar la acción: el puerto del servidor de la extensión no se pudo ' +
        'determinar (falta el argumento --port= al arrancar el proceso Electron).'
    );
  } else {
    postActionToExtension(extensionServerPort, action);
  }

  applyLocalActionEffect(action);
}

/**
 * Aplica el efecto local (dentro del propio proceso Electron) que
 * corresponde a `action`, si alguno. Sólo `hide-mascot` y `close-mascot`
 * tienen efecto local en esta tarea (11.2); las otras 4 acciones del menú
 * (`analyze-repository`, `precommit-review`, `show-seed-basket`,
 * `mute-messages`) no requieren ningún cambio local — su efecto vive
 * enteramente del lado de la extensión (ver design.md > "Menú contextual
 * y allowlist de acciones").
 *
 * Usa la variable de módulo `mascotWindow` (declarada más abajo en el
 * archivo) en vez de recibir `win` como parámetro: en JavaScript/
 * TypeScript, una función declarada con `function` es izada (hoisted) y
 * cualquier variable `let` de módulo referenciada en su cuerpo se resuelve
 * en tiempo de ejecución (closure), no en el orden textual de las
 * declaraciones — para cuando `processMascotAction` realmente se invoca
 * (tras un clic del menú contextual o un mensaje IPC), `mascotWindow` ya
 * fue asignada por `createMascotWindow()`. Confirmado compilando sin
 * errores de TypeScript (ver verificación de la tarea).
 */
function applyLocalActionEffect(action: MascotAction): void {
  switch (action.action) {
    case 'hide-mascot':
      mascotWindow?.hide();
      break;
    case 'close-mascot':
      mascotWindow?.close();
      app.quit();
      break;
    default:
      // Sin efecto local para el resto de acciones.
      break;
  }
}

/**
 * Registra el canal IPC `MASCOT_ACTION_CHANNEL` (tarea 8.2, Requirement
 * 9.2): valida cada mensaje recibido con `isMascotAction` antes de actuar
 * sobre él — un mensaje inválido se descarta silenciosamente y sólo se
 * loguea, nunca se reenvía a la extensión.
 */
function registerMascotActionChannel(): void {
  ipcMain.on(MASCOT_ACTION_CHANNEL, (_event, data: unknown) => {
    if (!isMascotAction(data)) {
      console.error('[Pluvianidae Mascot] Mensaje IPC inválido recibido en MASCOT_ACTION_CHANNEL; descartado.', data);
      return;
    }

    processMascotAction(data);
  });
}

/**
 * Referencia a la ventana de la mascota, usada por el handler de
 * 'second-instance' para enfocarla en vez de ignorar silenciosamente el
 * intento de lanzar un segundo proceso (ver tarea 5.2 / design.md
 * "Property 4: Instancia única de Electron").
 */
let mascotWindow: BrowserWindow | null = null;

/**
 * Calcula la posición inicial de la ventana: la posición guardada
 * previamente (`window-position.json` en `app.getPath('userData')`) si
 * existe y sigue siendo válida (dentro de algún display actualmente
 * conectado), o la posición por defecto (esquina inferior derecha del
 * display primario) en cualquier otro caso. Ver `resolveInitialPosition` en
 * `window-state.ts`.
 */
function computeInitialPosition(): WindowPosition {
  const savedPosition = readSavedPosition(getWindowPositionFilePath(app.getPath('userData')));
  return resolveInitialPosition(
    savedPosition,
    screen.getPrimaryDisplay().workArea,
    screen.getAllDisplays().map((display) => display.workArea)
  );
}

/** Crea y muestra la ventana flotante de la mascota. */
function createMascotWindow(): BrowserWindow {
  const initialPosition = computeInitialPosition();

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: initialPosition.x,
    y: initialPosition.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Por encima de la mayoría de apps, incluidas las de pantalla completa.
  win.setAlwaysOnTop(true, 'screen-saver');

  // Guardado debounced de posición (tarea 6.2). Se usa la misma ruta de
  // archivo que `computeInitialPosition()` para leer/escribir siempre el
  // mismo `window-position.json`. `win.getBounds()` se usa en vez de
  // `win.getPosition()` porque ya se llama en un contexto donde `bounds.x`/
  // `bounds.y` son directamente las coordenadas de pantalla que también
  // produce `getPosition()` para esta ventana (no es redimensionable), y
  // evita una llamada adicional si en el futuro también se quisiera
  // persistir el tamaño.
  const positionSaver = createDebouncedPositionSaver(
    getWindowPositionFilePath(app.getPath('userData'))
  );

  win.on('moved', () => {
    const bounds = win.getBounds();
    positionSaver.save({ x: bounds.x, y: bounds.y });
  });

  win.loadFile(path.join(__dirname, '..', '..', '..', 'index.html'));

  // Menú contextual (tarea 11.1): lista cerrada de 6 acciones, construida en
  // `context-menu.ts`. Cada acción seleccionada se procesa igual que si
  // hubiera llegado por `MASCOT_ACTION_CHANNEL` (ver `processMascotAction`).
  win.webContents.on('context-menu', (_event) => {
    const menu = buildMascotContextMenu(processMascotAction);
    menu.popup({ window: win });
  });

  mascotWindow = win;
  win.on('closed', () => {
    // Cancelar cualquier guardado pendiente: la ventana ya no existe, así
    // que no hay bounds válidos que persistir, y evita un timer huérfano
    // tras el cierre (limpieza de recursos, requirement 9.4).
    positionSaver.cancel();
    mascotWindow = null;
  });

  return win;
}

/**
 * Bloqueo de instancia única (tarea 5.2, design.md > "Evitar múltiples
 * servidores / múltiples procesos Electron" y "Property 4: Instancia única
 * de Electron").
 *
 * `app.requestSingleInstanceLock()` es la única fuente de verdad: no se
 * implementa ninguna detección propia de procesos duplicados (sin
 * lockfiles, sin verificación de PID). Si la propia API nativa fallara por
 * una causa ajena a este feature, `gotTheLock` sería `true` en ambos
 * procesos y simplemente coexistirían, tal como pide el diseño.
 */
const gotTheLock = app.requestSingleInstanceLock();

console.log("gotTheLock:", gotTheLock);

if (decideSingleInstanceOutcome(gotTheLock) === 'quit') {
  // Proceso perdedor: termina de inmediato, sin crear ninguna BrowserWindow.
  app.quit();
} else {
  // Si se lanza una segunda instancia mientras ésta ya tiene el lock,
  // enfocar/mostrar la ventana existente en vez de ignorarlo en silencio.
  app.on('second-instance', () => {
    if (mascotWindow) {
      if (mascotWindow.isMinimized()) {
        mascotWindow.restore();
      }
      mascotWindow.show();
      mascotWindow.focus();
    }
  });

  let sseHandle: MaintainConnectionHandle | undefined;

  app.whenReady().then(() => {
    const win = createMascotWindow();
    registerMascotActionChannel();

    // Conectar el cliente SSE al servidor local de la extensión y reenviar
    // cada MascotEvent recibido al renderer vía IPC (preload lo valida con
    // isMascotEvent antes de entregarlo a renderer.ts).
    if (extensionServerPort !== undefined) {
      sseHandle = maintainConnection({
        port: extensionServerPort,
        onMascotEvent: (event) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send(MASCOT_EVENT_CHANNEL, event);
          }
        },
        onHeartbeatTimeout: () => {
          console.error(
            '[Pluvianidae Mascot] Heartbeat SSE vencido: la extensión no responde. Cerrando mascota.'
          );
          app.quit();
        },
      });
    } else {
      console.warn(
        '[Pluvianidae Mascot] Sin --port= en argv: el cliente SSE no se iniciará. ' +
          'La mascota no recibirá eventos de la extensión.'
      );
    }
  });

  app.on('before-quit', () => {
    sseHandle?.stop();
  });
}

// Aplicación de una sola ventana, sin necesidad de reabrir en macOS al usar
// 'activate' (no aplica en v1: no hay dock icon relevante con skipTaskbar,
// y no se ofrece reabrir la mascota desde el dock).
app.on('window-all-closed', () => {
  app.quit();
});
