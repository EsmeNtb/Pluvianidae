/**
 * Script de preload de Electron: único puente entre el proceso `main` y el
 * `renderer`, expuesto vía `contextBridge`.
 *
 * Implementa la API `PluvianidaeMascotApi` (ver `ipc-channels.ts` y
 * design.md > "Componente 4: App Electron"): la ÚNICA superficie de
 * Node/Electron visible desde el renderer. No se expone `require`,
 * `process`, `ipcRenderer` directo, ni ninguna otra API de Node —
 * únicamente el objeto `{ onMascotEvent, sendAction }` (Requirement 9.1).
 *
 * Ambas direcciones se validan antes de cruzar el puente:
 * - `onMascotEvent`: todo dato recibido por `ipcRenderer.on(...)` se
 *   valida con `isMascotEvent` antes de invocar `callback`; si no es
 *   válido, se descarta silenciosamente (Requirement 9.2, 3.5).
 * - `sendAction`: toda acción se valida con `isMascotAction` ANTES de
 *   reenviarla vía `ipcRenderer.send(...)`; si no es válida, no se envía
 *   nada. Esto es defensa en profundidad — en la práctica el renderer
 *   sólo debería construir acciones válidas desde el menú contextual
 *   (`context-menu.ts`, tarea 11), pero el preload nunca confía en eso.
 *
 * Pendiente en tareas posteriores del plan de implementación:
 * - Tarea 8.2: `main.ts` validará también cada mensaje IPC recibido
 *   (`ipcMain.on(MASCOT_ACTION_CHANNEL, ...)`) antes de actuar sobre él.
 * - Tarea 9: `renderer.ts` consumirá `window.pluvianidae` para pintar
 *   animaciones/burbujas y disparar `sendAction` desde el menú contextual.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { isMascotEvent, type MascotEvent } from '../../shared/mascot-events';
import { isMascotAction, type MascotAction } from '../../shared/mascot-actions';
import {
  MASCOT_EVENT_CHANNEL,
  MASCOT_ACTION_CHANNEL,
  type PluvianidaeMascotApi,
} from './ipc-channels';

const pluvianidaeMascotApi: PluvianidaeMascotApi = {
  onMascotEvent(callback: (event: MascotEvent) => void): void {
    ipcRenderer.on(MASCOT_EVENT_CHANNEL, (_ipcEvent, data: unknown) => {
      if (!isMascotEvent(data)) {
        // Mensaje inválido: se descarta silenciosamente, sin propagarlo
        // nunca al renderer (Requirement 3.5, 9.2).
        return;
      }
      callback(data);
    });
  },

  sendAction(action: MascotAction): void {
    if (!isMascotAction(action)) {
      // Defensa en profundidad: el renderer sólo debería construir
      // acciones válidas desde el menú contextual, pero nunca se confía
      // ciegamente en eso antes de cruzar el proceso boundary.
      return;
    }
    ipcRenderer.send(MASCOT_ACTION_CHANNEL, action);
  },
};

contextBridge.exposeInMainWorld('pluvianidae', pluvianidaeMascotApi);

/**
 * Declaración global para tipar `window.pluvianidae` del lado del
 * renderer (`renderer.ts`, tarea 9), sin necesidad de un archivo `.d.ts`
 * separado.
 */
declare global {
  interface Window {
    pluvianidae: PluvianidaeMascotApi;
  }
}
