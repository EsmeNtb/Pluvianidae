"use strict";
/**
 * Cálculo y persistencia de la posición de la ventana de la mascota de
 * escritorio.
 *
 * Tarea 6.1 (completada): cálculo de la posición inicial por defecto
 * (esquina inferior derecha del display primario), ver `getDefaultPosition`.
 *
 * Tarea 6.2 (esta): guardado debounced de la posición en
 * `window-position.json` (vía `path.join(app.getPath('userData'), ...)`) y
 * restauración validada contra `screen.getAllDisplays()`. El arrastre de la
 * ventana (CSS `-webkit-app-region`) se implementa en la tarea 6.3 y no se
 * anticipa aquí.
 *
 * `getDefaultPosition`, `isPositionWithinAnyDisplay` y `resolveInitialPosition`
 * son funciones puras (no llaman a `screen`/`fs`/`path`/Electron) para
 * poder probarlas con datos arbitrarios sin mockear el módulo `electron`
 * completo (tarea 6.4). `main.ts` es responsable de obtener los datos de
 * `screen`/`app` y pasarlos aquí. Las funciones de I/O
 * (`getWindowPositionFilePath`, `readSavedPosition`, `writeSavedPosition`,
 * `createDebouncedPositionSaver`) sí usan `fs`/`path` y viven en este mismo
 * archivo porque son la única responsabilidad de "estado de la ventana";
 * separarlas en otro archivo no aportaría aislamiento adicional dado que
 * ya son el único punto de I/O de este módulo.
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
exports.createDebouncedPositionSaver = exports.DEFAULT_POSITION_SAVE_DEBOUNCE_MS = exports.writeSavedPosition = exports.readSavedPosition = exports.getWindowPositionFilePath = exports.resolveInitialPosition = exports.isPositionWithinAnyDisplay = exports.WINDOW_POSITION_FILE_NAME = exports.getDefaultPosition = exports.DEFAULT_MARGIN = exports.WINDOW_HEIGHT = exports.WINDOW_WIDTH = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Ancho de la ventana de la mascota (ver design.md > "Ventana Electron"). */
exports.WINDOW_WIDTH = 260;
/** Alto de la ventana de la mascota (ver design.md > "Ventana Electron"). */
exports.WINDOW_HEIGHT = 240;
/**
 * Margen, en píxeles, entre el borde de la ventana y el borde del área de
 * trabajo al calcular la posición por defecto (esquina inferior derecha).
 *
 * 20px es un valor convencional para mantener la mascota visualmente
 * separada de la barra de tareas y del borde de la pantalla sin ocupar
 * espacio significativo del área de trabajo; no está especificado
 * explícitamente en requirements.md/design.md más allá de "esquina
 * inferior derecha", por lo que se documenta aquí la elección.
 */
exports.DEFAULT_MARGIN = 20;
/**
 * Calcula la posición por defecto de la ventana de la mascota: la esquina
 * inferior derecha del área de trabajo recibida, respetando `DEFAULT_MARGIN`.
 *
 * Función pura: no llama a `screen.getPrimaryDisplay()` ni a ninguna otra
 * API de Electron. El llamador (`main.ts`) debe pasar
 * `screen.getPrimaryDisplay().workArea` como argumento.
 *
 * @param primaryDisplayWorkArea - el `workArea` del display primario
 * (o de cualquier display, para pruebas con datos arbitrarios).
 */
function getDefaultPosition(primaryDisplayWorkArea) {
    const x = primaryDisplayWorkArea.x +
        primaryDisplayWorkArea.width -
        exports.WINDOW_WIDTH -
        exports.DEFAULT_MARGIN;
    const y = primaryDisplayWorkArea.y +
        primaryDisplayWorkArea.height -
        exports.WINDOW_HEIGHT -
        exports.DEFAULT_MARGIN;
    return { x, y };
}
exports.getDefaultPosition = getDefaultPosition;
/**
 * Nombre del archivo de persistencia de posición dentro del directorio de
 * datos de usuario de Electron (`app.getPath('userData')`).
 */
exports.WINDOW_POSITION_FILE_NAME = 'window-position.json';
/**
 * Determina si `position` cae dentro de al menos uno de los rectángulos de
 * `displayWorkAreas`.
 *
 * Elección de diseño: se trata `position` como un único punto (x, y) —la
 * esquina superior izquierda de la ventana— en vez de comprobar que el
 * rectángulo completo de WINDOW_WIDTH x WINDOW_HEIGHT quede contenido en un
 * display. Esto es suficiente para el requirement (evitar que la ventana
 * "desaparezca" tras desconectar un monitor): si la esquina superior
 * izquierda es visible en algún display, el usuario puede ver y arrastrar
 * la ventana de vuelta a una posición completamente visible si hiciera
 * falta. Exigir el rectángulo completo complicaría la validación en setups
 * multi-monitor con distintas resoluciones/orientaciones sin aportar
 * beneficio real para este caso de uso.
 *
 * Función pura: no llama a `screen.getAllDisplays()` directamente (ver
 * cabecera del archivo).
 */
function isPositionWithinAnyDisplay(position, displayWorkAreas) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        return false;
    }
    return displayWorkAreas.some((workArea) => {
        return (position.x >= workArea.x &&
            position.x < workArea.x + workArea.width &&
            position.y >= workArea.y &&
            position.y < workArea.y + workArea.height);
    });
}
exports.isPositionWithinAnyDisplay = isPositionWithinAnyDisplay;
/**
 * Resuelve la posición inicial a usar al arrancar la ventana: la posición
 * guardada si existe y es válida (dentro de algún display actualmente
 * conectado), o la posición por defecto en cualquier otro caso.
 *
 * Función pura.
 */
function resolveInitialPosition(savedPosition, primaryDisplayWorkArea, allDisplayWorkAreas) {
    if (savedPosition !== undefined &&
        isPositionWithinAnyDisplay(savedPosition, allDisplayWorkAreas)) {
        return savedPosition;
    }
    return getDefaultPosition(primaryDisplayWorkArea);
}
exports.resolveInitialPosition = resolveInitialPosition;
/**
 * Construye la ruta absoluta al archivo de persistencia de posición, dentro
 * del directorio de datos de usuario de Electron.
 *
 * Usa siempre `path.join` (nunca concatenación manual de rutas, ver
 * requirement 9.6).
 */
function getWindowPositionFilePath(userDataPath) {
    return path.join(userDataPath, exports.WINDOW_POSITION_FILE_NAME);
}
exports.getWindowPositionFilePath = getWindowPositionFilePath;
/** Type guard mínimo para el contenido esperado del archivo de posición. */
function isValidStoredPosition(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value;
    return (typeof record.x === 'number' &&
        Number.isFinite(record.x) &&
        typeof record.y === 'number' &&
        Number.isFinite(record.y));
}
/**
 * Lee y valida la posición guardada previamente en `filePath`.
 *
 * Nunca lanza: cualquier fallo (archivo inexistente, JSON corrupto, forma
 * inválida) se traduce en `undefined`, dejando a `resolveInitialPosition`
 * decidir el fallback a la posición por defecto.
 */
function readSavedPosition(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    return isValidStoredPosition(parsed) ? parsed : undefined;
}
exports.readSavedPosition = readSavedPosition;
/**
 * Escribe `position` en `filePath`, de mejor esfuerzo: si falla (p. ej.
 * permisos, disco lleno, directorio inexistente), se loguea el error con
 * `console.error` y la función retorna normalmente. Nunca lanza ni tumba el
 * proceso — persistir la posición de la ventana no es una operación
 * crítica para el funcionamiento de la mascota.
 */
function writeSavedPosition(filePath, position) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(position), 'utf8');
    }
    catch (error) {
        console.error('[window-state] No se pudo guardar la posición de la ventana:', error);
    }
}
exports.writeSavedPosition = writeSavedPosition;
/** Debounce por defecto (ms) para el guardado de posición tras 'moved'. */
exports.DEFAULT_POSITION_SAVE_DEBOUNCE_MS = 500;
/**
 * Crea un guardador de posición debounced: cada llamada a `save(position)`
 * reinicia el temporizador (debounce real, no throttle); al vencer sin
 * nuevas llamadas, se escribe la posición más reciente vía
 * `writeSavedPosition`. `cancel()` limpia cualquier temporizador pendiente
 * sin escribir, para limpieza de recursos (p. ej. en el handler `closed` de
 * la ventana o en `dispose()`).
 *
 * `debounceMs` por defecto es `DEFAULT_POSITION_SAVE_DEBOUNCE_MS` (500ms),
 * el valor sugerido explícitamente en design.md ("Arrastre y persistencia
 * de posición"): suficiente para no escribir a disco en cada pixel de
 * arrastre, sin introducir un retraso perceptible tras soltar la ventana.
 */
function createDebouncedPositionSaver(filePath, debounceMs = exports.DEFAULT_POSITION_SAVE_DEBOUNCE_MS) {
    let timer;
    return {
        save(position) {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                timer = undefined;
                writeSavedPosition(filePath, position);
            }, debounceMs);
        },
        cancel() {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
}
exports.createDebouncedPositionSaver = createDebouncedPositionSaver;
//# sourceMappingURL=window-state.js.map