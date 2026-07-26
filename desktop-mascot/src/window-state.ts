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

import * as fs from 'fs';
import * as path from 'path';

/** Posición de la ventana de la mascota, en coordenadas de pantalla. */
export interface WindowPosition {
  x: number;
  y: number;
}

/** Ancho de la ventana de la mascota (ver design.md > "Ventana Electron"). */
export const WINDOW_WIDTH = 260;

/** Alto de la ventana de la mascota (ver design.md > "Ventana Electron"). */
export const WINDOW_HEIGHT = 240;

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
export const DEFAULT_MARGIN = 20;

/** Forma mínima de `Electron.Rectangle` que esta función necesita. */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
export function getDefaultPosition(
  primaryDisplayWorkArea: WorkArea
): WindowPosition {
  const x =
    primaryDisplayWorkArea.x +
    primaryDisplayWorkArea.width -
    WINDOW_WIDTH -
    DEFAULT_MARGIN;
  const y =
    primaryDisplayWorkArea.y +
    primaryDisplayWorkArea.height -
    WINDOW_HEIGHT -
    DEFAULT_MARGIN;

  return { x, y };
}

/**
 * Nombre del archivo de persistencia de posición dentro del directorio de
 * datos de usuario de Electron (`app.getPath('userData')`).
 */
export const WINDOW_POSITION_FILE_NAME = 'window-position.json';

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
export function isPositionWithinAnyDisplay(
  position: WindowPosition,
  displayWorkAreas: WorkArea[]
): boolean {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return false;
  }

  return displayWorkAreas.some((workArea) => {
    return (
      position.x >= workArea.x &&
      position.x < workArea.x + workArea.width &&
      position.y >= workArea.y &&
      position.y < workArea.y + workArea.height
    );
  });
}

/**
 * Resuelve la posición inicial a usar al arrancar la ventana: la posición
 * guardada si existe y es válida (dentro de algún display actualmente
 * conectado), o la posición por defecto en cualquier otro caso.
 *
 * Función pura.
 */
export function resolveInitialPosition(
  savedPosition: WindowPosition | undefined,
  primaryDisplayWorkArea: WorkArea,
  allDisplayWorkAreas: WorkArea[]
): WindowPosition {
  if (
    savedPosition !== undefined &&
    isPositionWithinAnyDisplay(savedPosition, allDisplayWorkAreas)
  ) {
    return savedPosition;
  }

  return getDefaultPosition(primaryDisplayWorkArea);
}

/**
 * Construye la ruta absoluta al archivo de persistencia de posición, dentro
 * del directorio de datos de usuario de Electron.
 *
 * Usa siempre `path.join` (nunca concatenación manual de rutas, ver
 * requirement 9.6).
 */
export function getWindowPositionFilePath(userDataPath: string): string {
  return path.join(userDataPath, WINDOW_POSITION_FILE_NAME);
}

/** Type guard mínimo para el contenido esperado del archivo de posición. */
function isValidStoredPosition(value: unknown): value is WindowPosition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.x === 'number' &&
    Number.isFinite(record.x) &&
    typeof record.y === 'number' &&
    Number.isFinite(record.y)
  );
}

/**
 * Lee y valida la posición guardada previamente en `filePath`.
 *
 * Nunca lanza: cualquier fallo (archivo inexistente, JSON corrupto, forma
 * inválida) se traduce en `undefined`, dejando a `resolveInitialPosition`
 * decidir el fallback a la posición por defecto.
 */
export function readSavedPosition(filePath: string): WindowPosition | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  return isValidStoredPosition(parsed) ? parsed : undefined;
}

/**
 * Escribe `position` en `filePath`, de mejor esfuerzo: si falla (p. ej.
 * permisos, disco lleno, directorio inexistente), se loguea el error con
 * `console.error` y la función retorna normalmente. Nunca lanza ni tumba el
 * proceso — persistir la posición de la ventana no es una operación
 * crítica para el funcionamiento de la mascota.
 */
export function writeSavedPosition(filePath: string, position: WindowPosition): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(position), 'utf8');
  } catch (error) {
    console.error('[window-state] No se pudo guardar la posición de la ventana:', error);
  }
}

/** Debounce por defecto (ms) para el guardado de posición tras 'moved'. */
export const DEFAULT_POSITION_SAVE_DEBOUNCE_MS = 500;

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
export function createDebouncedPositionSaver(
  filePath: string,
  debounceMs: number = DEFAULT_POSITION_SAVE_DEBOUNCE_MS
): { save: (position: WindowPosition) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    save(position: WindowPosition): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        writeSavedPosition(filePath, position);
      }, debounceMs);
    },
    cancel(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
