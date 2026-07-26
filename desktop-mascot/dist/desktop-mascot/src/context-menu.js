"use strict";
/**
 * Menú contextual nativo de la mascota de escritorio (tarea 11.1).
 *
 * Ver .kiro/specs/desktop-mascot/design.md > "Menú contextual y allowlist
 * de acciones" para la lista exacta y su justificación.
 *
 * Allowlist cerrada por construcción: esta función sólo puede producir uno
 * de los 6 `MascotAction` literales escritos explícitamente abajo. No hay
 * ninguna forma de generar un `MascotAction` distinto a partir de este
 * menú (no se construye a partir de datos externos, configuración, ni
 * ningún valor variable) — la propia firma de `Menu.buildFromTemplate`
 * exige un `label` y un `click` fijos por entrada, así que la allowlist a
 * nivel de UI queda garantizada por el compilador de TypeScript y por la
 * forma del código, no por una validación en tiempo de ejecución.
 * (La validación en tiempo de ejecución con `isMascotAction` sigue
 * existiendo aguas abajo, en `main.ts` y en la extensión, como defensa en
 * profundidad — ver design.md > "Protocolo de comunicación".)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMascotContextMenu = void 0;
const electron_1 = require("electron");
/**
 * Construye el menú contextual nativo de la mascota con exactamente las 6
 * opciones permitidas (ver design.md). Cada opción invoca `onAction` con un
 * único `MascotAction` literal; no se añaden separadores, submenús ni
 * opciones adicionales.
 */
function buildMascotContextMenu(onAction) {
    return electron_1.Menu.buildFromTemplate([
        { label: 'Analizar repositorio', click: () => onAction({ action: 'analyze-repository' }) },
        { label: 'Revisión pre-commit', click: () => onAction({ action: 'precommit-review' }) },
        { label: 'Mostrar cesto de semillas', click: () => onAction({ action: 'show-seed-basket' }) },
        { label: 'Silenciar mensajes', click: () => onAction({ action: 'mute-messages' }) },
        { label: 'Ocultar mascota', click: () => onAction({ action: 'hide-mascot' }) },
        { label: 'Cerrar mascota', click: () => onAction({ action: 'close-mascot' }) },
    ]);
}
exports.buildMascotContextMenu = buildMascotContextMenu;
//# sourceMappingURL=context-menu.js.map