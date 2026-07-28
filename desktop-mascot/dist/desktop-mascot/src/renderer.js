"use strict";
/**
 * Script del proceso `renderer`: pinta la mascota (animaciones, burbujas) y
 * reacciona a los eventos recibidos vía la API expuesta por `preload.ts`.
 *
 * La tarea 9.1 (ver .kiro/specs/desktop-mascot/tasks.md) implementó el
 * mapeo `MascotEvent` -> estado visual/clase CSS de animación y su
 * aplicación al DOM (`#mascot-root`). La tarea 10.1 añade, sobre el mismo
 * flujo de `initMascotRenderer()`, el renderizado de la burbuja de
 * mensaje (`#mascot-bubble`) cuando el evento trae un texto visible. Todavía
 * NO implementado:
 *   - Arrastre de ventana (tarea 6.3, `-webkit-app-region`, vive en CSS).
 *   - Menú contextual (tarea 11).
 *
 * ## Mapeo evento -> estado visual (design.md > "Estados visuales y
 * animaciones")
 *
 * | `MascotEvent.type` | `MascotVisualState` | Nota |
 * |---|---|---|
 * | `idle`     | `idle`     | respiración suave |
 * | `indexing` | `working`  | saltos pequeños |
 * | `success`  | `success`  | "semillas cayendo" en design.md; en esta tarea sólo se define la clase CSS de énfasis (ver styles.css) — el detalle visual real de semillas queda para la tarea 10 (burbujas) si aplica |
 * | `warning`  | `warning`  | vibración breve |
 * | `error`    | `error`    | sobresalto |
 * | `seed`     | `success`  | design.md no le da un estado propio entre los 7; se trata como parte de "success" para el propósito del mapeo de animación de esta tarea. La lógica de burbuja/animación de semillas dedicada, si se necesita, se decide en la tarea 10 |
 * | `hide`     | `sleeping` | opacidad reducida, "antes de completar la ocultación del todo" (design.md, Requirement 5.7) — la ventana en sí se oculta más tarde vía `main.ts`/`BrowserWindow.hide()`, no en este archivo |
 * | `show`     | `idle`     | design.md no define un estado visual "show" explícito entre los 7 estados; al volver a mostrarse la mascota simplemente retoma `idle` por defecto |
 * | (cualquier otro/no reconocido) | `idle` | fallback por defecto (Requirement 5.2) |
 *
 * `thinking` existe como clase CSS/estado soportado (ver styles.css) pero
 * NO tiene ningún `MascotEvent` que lo dispare en esta versión — design.md
 * lo documenta como un estado "interno: mientras se espera respuesta tras
 * una acción del menú", fuera del alcance de esta tarea (que sólo mapea
 * `MascotEvent`s recibidos vía `window.pluvianidae.onMascotEvent`). Podría
 * usarse en el futuro para el intervalo entre `sendAction()` y la
 * respuesta correspondiente de la extensión.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.showBubble = exports.extractBubbleText = exports.BUBBLE_VISIBLE_CLASS = exports.BUBBLE_AUTO_HIDE_MS = exports.applyVisualState = exports.mapEventToVisualState = exports.MASCOT_VISUAL_STATES = exports.MASCOT_STATE_CLASS_PREFIX = void 0;
/** Prefijo común de las clases CSS de estado, usado tanto aquí como en `styles.css`. */
exports.MASCOT_STATE_CLASS_PREFIX = 'mascot-state-';
/** Todos los estados visuales soportados, usado para poder removerlos todos antes de aplicar uno nuevo. */
exports.MASCOT_VISUAL_STATES = [
    'idle',
    'thinking',
    'working',
    'success',
    'warning',
    'error',
    'sleeping',
];
/**
 * Mapea el `type` de un `MascotEvent` (ya validado por `preload.ts` vía
 * `isMascotEvent` antes de llegar aquí) a su `MascotVisualState`
 * correspondiente. Función pura y testeable en aislamiento (tarea 9.2),
 * sin ningún acceso al DOM ni a `window.pluvianidae`.
 *
 * Cualquier `type` no reconocido cae a `'idle'` por defecto
 * (Requirement 5.2). Esto incluye, en la práctica, cualquier valor futuro
 * que `shared/mascot-events.ts` pudiera añadir a `MASCOT_EVENT_TYPES` sin
 * que este mapeo se actualice todavía — nunca se lanza una excepción por
 * un `type` desconocido.
 */
function mapEventToVisualState(event) {
    switch (event.type) {
        case 'idle':
            return 'idle';
        case 'indexing':
            return 'working';
        case 'success':
            return 'success';
        case 'warning':
            return 'warning';
        case 'error':
            return 'error';
        // design.md no distingue un estado visual propio para 'seed' entre los
        // 7 de la tabla "Estados visuales y animaciones"; se trata junto a
        // 'success' para el propósito del mapeo de animación (ver doc
        // comment de este módulo).
        case 'seed':
            return 'success';
        // Requirement 5.7: opacidad reducida "antes de completar la
        // ocultación" — la ocultación real de la ventana la maneja main.ts.
        case 'hide':
            return 'sleeping';
        // No hay un estado visual "show" explícito en design.md: al volver a
        // mostrarse, la mascota retoma idle por defecto.
        case 'show':
            return 'idle';
        default:
            // Fallback a idle por defecto (Requirement 5.2) para cualquier
            // `type` no reconocido/futuro.
            return 'idle';
    }
}
exports.mapEventToVisualState = mapEventToVisualState;
/**
 * Aplica `state` al contenedor raíz `root` como clase CSS
 * (`mascot-state-<state>`), removiendo primero cualquier otra clase de
 * estado que pudiera estar presente, para que las animaciones CSS con
 * `@keyframes` puedan reiniciarse limpiamente en cada cambio de estado
 * (en vez de quedarse "congeladas" si el mismo estado se reaplica, o de
 * acumular clases de estados anteriores).
 */
function applyVisualState(root, state) {
    for (const visualState of exports.MASCOT_VISUAL_STATES) {
        root.classList.remove(exports.MASCOT_STATE_CLASS_PREFIX + visualState);
    }
    root.classList.add(exports.MASCOT_STATE_CLASS_PREFIX + state);
}
exports.applyVisualState = applyVisualState;
const emojiByState = {
    idle: '🐦',
    thinking: '🐤',
    working: '🐦‍⬛',
    success: '🐥',
    warning: '🐦',
    error: '🐧',
    sleeping: '💤',
};
function applyMascotEmoji(character, state) {
    character.textContent = emojiByState[state];
    character.setAttribute('aria-label', `Pluvianidae en estado ${state}`);
}
function spawnSeeds(seedLayer, amount = 8) {
    const safeAmount = Math.min(Math.max(amount, 1), 20);
    for (let index = 0; index < safeAmount; index += 1) {
        const seed = document.createElement('span');
        seed.className = 'seed';
        seed.textContent = '🌾';
        seed.style.left = `${10 + Math.random() * 80}%`;
        seed.style.animationDelay = `${Math.random() * 0.5}s`;
        seed.style.animationDuration = `${1.4 + Math.random() * 0.8}s`;
        seed.addEventListener('animationend', () => {
            seed.remove();
        });
        seedLayer.appendChild(seed);
    }
}
/**
 * Tiempo (ms) que la burbuja permanece visible antes de auto-ocultarse
 * (Requirement 6.4). Valor sugerido por design.md > "Burbujas" (4000ms).
 * Exportado para que la prueba unitaria (tarea 10.2) pueda usarlo o pasar
 * un valor distinto explícitamente a `showBubble`.
 */
exports.BUBBLE_AUTO_HIDE_MS = 4000;
/** Clase CSS (ver `styles.css`) que hace visible `#mascot-bubble`. */
exports.BUBBLE_VISIBLE_CLASS = 'mascot-bubble-visible';
/**
 * Extrae, de forma pura (sin tocar el DOM), el texto visible en la
 * burbuja para un `MascotEvent` dado, si tiene uno.
 *
 * Mapeo por `type` (design.md > "Burbujas", Requirement 6.1):
 *   - `success` / `warning` / `error`: su campo `message`.
 *   - `indexing`: su campo `file` si está presente; si no, `undefined`
 *     (no hay texto que mostrar — sólo la animación/estado `working` de
 *     la tarea 9.1, sin depender de un `progress` numérico para la
 *     burbuja).
 *   - `idle` / `hide` / `show`: `undefined`, no tienen ningún campo de
 *     texto en `shared/mascot-events.ts`.
 *   - `seed`: `undefined` en esta tarea. `shared/mascot-events.ts` sólo le
 *     da un campo `amount: number`, no un `message`; design.md tampoco
 *     especifica un texto sintético para este caso. Generar aquí un
 *     texto como "+N semillas" sería inventar un requisito no pedido
 *     explícitamente (ver `<default_to_action>`/alcance de la tarea) —
 *     se deja sin burbuja por ahora. El estado visual de `seed` (mapeado
 *     a `success` en `mapEventToVisualState`) ya se sigue animando con
 *     normalidad.
 *
 * Cualquier `type` no reconocido (fallback futuro) también retorna
 * `undefined`, nunca lanza.
 */
function extractBubbleText(event) {
    switch (event.type) {
        case 'success':
        case 'warning':
        case 'error':
            return event.message;
        case 'indexing':
            return event.file;
        case 'idle':
        case 'seed':
        case 'hide':
        case 'show':
        default:
            return undefined;
    }
}
exports.extractBubbleText = extractBubbleText;
/**
 * Timer del auto-ocultado en curso, si alguno. Módulo-nivel porque sólo
 * existe una burbuja (`#mascot-bubble`) en toda la ventana; se limpia
 * explícitamente en cada llamada a `showBubble` (comportamiento tipo
 * debounce, ver doc comment de `showBubble`).
 */
let bubbleHideTimer;
/**
 * Escribe `text` en `bubbleElement` y lo hace visible, con auto-ocultado
 * tras `autoHideMs`.
 *
 * Requirement 6.3 (regla de seguridad no negociable): el texto se inserta
 * EXCLUSIVAMENTE vía `textContent`. Nunca se usa `innerHTML` para
 * contenido proveniente de un `MascotEvent` — `textContent` escapa
 * automáticamente cualquier carácter que pudiera interpretarse como
 * markup, por lo que un `text` malicioso (p. ej. `"<img
 * src=x onerror=...>"`) se pinta literalmente como texto, nunca se
 * interpreta como HTML.
 *
 * El mismo `text` se pone también en el atributo `title` (tooltip nativo
 * del sistema/navegador), que sigue mostrando el mensaje completo aunque
 * el CSS trunque visualmente el contenido (Requirement 6.2). `title` es
 * un atributo de texto plano (vía la propiedad IDL `title`, no
 * `innerHTML`/`insertAdjacentHTML`), así que no reintroduce ningún riesgo
 * de inyección de markup.
 *
 * Auto-ocultado (Requirement 6.4): se programa un `setTimeout` que, al
 * vencer, remueve la clase de visibilidad y limpia `textContent`/`title`.
 * Si `showBubble` se llama de nuevo antes de que ese timeout venza (p. ej.
 * un segundo `MascotEvent` con mensaje llega mientras la burbuja anterior
 * sigue visible), el timer anterior se cancela primero — así un mensaje
 * nuevo nunca se oculta prematuramente por el timer de un mensaje viejo,
 * y cada llamada reinicia el tiempo completo de visibilidad desde cero.
 */
function showBubble(bubbleElement, text, autoHideMs = exports.BUBBLE_AUTO_HIDE_MS) {
    if (bubbleHideTimer !== undefined) {
        clearTimeout(bubbleHideTimer);
        bubbleHideTimer = undefined;
    }
    bubbleElement.textContent = text;
    bubbleElement.title = text;
    bubbleElement.classList.add(exports.BUBBLE_VISIBLE_CLASS);
    bubbleHideTimer = setTimeout(() => {
        bubbleHideTimer = undefined;
        bubbleElement.classList.remove(exports.BUBBLE_VISIBLE_CLASS);
        bubbleElement.textContent = '';
        bubbleElement.title = '';
    }, autoHideMs);
}
exports.showBubble = showBubble;
/**
 * Punto de entrada del renderer: se suscribe a `window.pluvianidae.onMascotEvent`
 * y, por cada evento recibido, (a) mapea y aplica el estado visual
 * correspondiente al contenedor raíz `#mascot-root` (tarea 9.1) y (b),
 * si el evento trae un texto visible (tarea 10.1), actualiza la burbuja
 * `#mascot-bubble`.
 *
 * Sólo se ejecuta cuando `window.pluvianidae` existe (es decir, dentro del
 * proceso `renderer` real de Electron, tras `preload.ts`) — esta guarda
 * permite que `mapEventToVisualState`/`applyVisualState`/
 * `extractBubbleText`/`showBubble` se importen y prueben de forma aislada
 * sin necesidad de un entorno Electron completo ni de simular
 * `window.pluvianidae`.
 */
function initMascotRenderer() {
    if (typeof window === 'undefined' || !window.pluvianidae) {
        return;
    }
    const root = document.getElementById('mascot-root');
    if (!root) {
        return;
    }
    const character = document.getElementById('mascot-character');
    const seedLayer = document.getElementById('seed-layer');
    if (!character) {
        return;
    }
    applyVisualState(root, 'idle');
    applyMascotEmoji(character, 'idle');
    const bubble = document.getElementById('mascot-bubble');
    window.pluvianidae.onMascotEvent((event) => {
        const visualState = mapEventToVisualState(event);
        applyVisualState(root, visualState);
        applyMascotEmoji(character, visualState);
        if (event.type === 'seed' && seedLayer) {
            spawnSeeds(seedLayer, event.amount);
        }
        if (event.type === 'success' && seedLayer) {
            spawnSeeds(seedLayer, 8);
        }
        if (!bubble) {
            return;
        }
        const bubbleText = extractBubbleText(event);
        if (bubbleText !== undefined) {
            showBubble(bubble, bubbleText, exports.BUBBLE_AUTO_HIDE_MS);
        }
    });
}
initMascotRenderer();
//# sourceMappingURL=renderer.js.map