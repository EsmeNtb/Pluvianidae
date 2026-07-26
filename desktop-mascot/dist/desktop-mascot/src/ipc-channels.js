"use strict";
/**
 * Nombres de canal IPC usados entre `main.ts` y `preload.ts`/`renderer.ts`,
 * y forma de la API expuesta al renderer vía `contextBridge`.
 *
 * Mantener estos nombres como constantes (en vez de repetir el string
 * literal en `main.ts` y `preload.ts`) evita que un typo en un extremo del
 * canal quede silenciosamente sin efecto (ver design.md > "Componente 4:
 * App Electron" y Requirement 9.2: todo mensaje IPC entre `preload`/`main`
 * y `main`/`renderer` debe validarse, lo que empieza por que ambos lados
 * usen exactamente el mismo nombre de canal).
 *
 * - `MASCOT_EVENT_CHANNEL`: dirección `main` -> `renderer`. `main.ts`
 *   reenvía aquí (tarea 7) cada `MascotEvent` válido recibido del
 *   `sse-client.ts` mediante `webContents.send(MASCOT_EVENT_CHANNEL, event)`.
 * - `MASCOT_ACTION_CHANNEL`: dirección `renderer` -> `main`. El renderer
 *   (vía la API expuesta por `preload.ts`) envía aquí cada `MascotAction`
 *   originada en el menú contextual mediante
 *   `ipcRenderer.send(MASCOT_ACTION_CHANNEL, action)`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MASCOT_ACTION_CHANNEL = exports.MASCOT_EVENT_CHANNEL = void 0;
/** Canal IPC: `main` -> `renderer`, reenvío de `MascotEvent`. */
exports.MASCOT_EVENT_CHANNEL = 'pluvianidae:mascot-event';
/** Canal IPC: `renderer` -> `main`, envío de `MascotAction`. */
exports.MASCOT_ACTION_CHANNEL = 'pluvianidae:mascot-action';
//# sourceMappingURL=ipc-channels.js.map