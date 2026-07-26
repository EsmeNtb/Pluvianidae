"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const mascot_events_1 = require("../../shared/mascot-events");
const mascot_actions_1 = require("../../shared/mascot-actions");
const ipc_channels_1 = require("./ipc-channels");
const pluvianidaeMascotApi = {
    onMascotEvent(callback) {
        electron_1.ipcRenderer.on(ipc_channels_1.MASCOT_EVENT_CHANNEL, (_ipcEvent, data) => {
            if (!(0, mascot_events_1.isMascotEvent)(data)) {
                // Mensaje inválido: se descarta silenciosamente, sin propagarlo
                // nunca al renderer (Requirement 3.5, 9.2).
                return;
            }
            callback(data);
        });
    },
    sendAction(action) {
        if (!(0, mascot_actions_1.isMascotAction)(action)) {
            // Defensa en profundidad: el renderer sólo debería construir
            // acciones válidas desde el menú contextual, pero nunca se confía
            // ciegamente en eso antes de cruzar el proceso boundary.
            return;
        }
        electron_1.ipcRenderer.send(ipc_channels_1.MASCOT_ACTION_CHANNEL, action);
    },
};
electron_1.contextBridge.exposeInMainWorld('pluvianidae', pluvianidaeMascotApi);
//# sourceMappingURL=preload.js.map