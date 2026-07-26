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

import type { MascotEvent } from '../../shared/mascot-events';
import type { MascotAction } from '../../shared/mascot-actions';

/** Canal IPC: `main` -> `renderer`, reenvío de `MascotEvent`. */
export const MASCOT_EVENT_CHANNEL = 'pluvianidae:mascot-event';

/** Canal IPC: `renderer` -> `main`, envío de `MascotAction`. */
export const MASCOT_ACTION_CHANNEL = 'pluvianidae:mascot-action';

/**
 * Forma de la API expuesta al `renderer` por `preload.ts` mediante
 * `contextBridge.exposeInMainWorld('pluvianidae', ...)`.
 *
 * Ver design.md > "Componente 4: App Electron" > sección "Interface" para
 * la interfaz `PluvianidaeMascotApi` tal como fue especificada en el
 * diseño. Esta es la ÚNICA superficie de Node/Electron visible desde el
 * renderer (Requirement 9.1): ninguna otra referencia a `require`,
 * `process`, `ipcRenderer` directo, etc. debe llegar al renderer.
 */
export interface PluvianidaeMascotApi {
  /**
   * Se suscribe a los `MascotEvent` reenviados por `main.ts`. `callback`
   * sólo se invoca con eventos que ya pasaron `isMascotEvent` — ningún
   * dato inválido llega nunca al renderer.
   */
  onMascotEvent(callback: (event: MascotEvent) => void): void;

  /**
   * Envía una `MascotAction` hacia `main.ts`. Si `action` no pasa
   * `isMascotAction`, no se envía nada (defensa en profundidad).
   */
  sendAction(action: MascotAction): void;
}
