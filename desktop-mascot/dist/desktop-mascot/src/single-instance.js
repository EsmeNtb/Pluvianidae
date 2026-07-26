"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideSingleInstanceOutcome = void 0;
/**
 * Decisión pura del desenlace del bloqueo de instancia única de Electron.
 *
 * Extraída de `main.ts` a su propio módulo (tarea 5.3, design.md >
 * "Property 4: Instancia única de Electron") para que sea importable de
 * forma aislada en pruebas sin ejecutar el resto de `main.ts` (que, al
 * importarse, corre código a nivel de módulo que llama a
 * `app.requestSingleInstanceLock()` y sólo funciona dentro de un proceso
 * Electron real) y sin depender en absoluto del módulo `electron`.
 *
 * `main.ts` llama a `app.requestSingleInstanceLock()` (la única fuente de
 * verdad; no hay detección propia de procesos duplicados) y pasa el
 * resultado aquí para decidir si debe terminar (`app.quit()`, sin crear
 * ninguna `BrowserWindow`) o continuar con el arranque normal.
 */
function decideSingleInstanceOutcome(gotTheLock) {
    return gotTheLock ? 'proceed' : 'quit';
}
exports.decideSingleInstanceOutcome = decideSingleInstanceOutcome;
//# sourceMappingURL=single-instance.js.map