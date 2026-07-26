// @vitest-environment jsdom
/**
 * Pruebas unitarias de `desktop-mascot/src/renderer.ts` (tarea 10.2, ver
 * .kiro/specs/desktop-mascot/tasks.md).
 *
 * Foco exclusivo de esta tarea (Requirement 6.3): verificar que el texto
 * de la burbuja se inserta EXCLUSIVAMENTE vía `textContent`, nunca vía
 * `innerHTML` — es decir, que `showBubble` es seguro frente a contenido
 * potencialmente malicioso proveniente de un `MascotEvent` (prevención
 * XSS). También cubre `extractBubbleText` (mapeo puro `MascotEvent` ->
 * texto) y el comportamiento de debounce/reset del auto-ocultado.
 *
 * Requiere un DOM real: se usa el entorno `jsdom` (directiva
 * `@vitest-environment jsdom` arriba, aplicada sólo a este archivo — el
 * resto de la suite sigue en el entorno por defecto de Vitest) y
 * `document.createElement`, en línea con la sugerencia de la tarea.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractBubbleText,
  showBubble,
  BUBBLE_AUTO_HIDE_MS,
  BUBBLE_VISIBLE_CLASS,
  mapEventToVisualState,
  applyVisualState,
  MASCOT_STATE_CLASS_PREFIX,
  MASCOT_VISUAL_STATES,
} from '../../../desktop-mascot/src/renderer';
import type { MascotEvent } from '../../../shared/mascot-events';

describe('mapEventToVisualState', () => {
  it('mapea idle -> idle', () => {
    expect(mapEventToVisualState({ type: 'idle' })).toBe('idle');
  });

  it('mapea indexing -> working', () => {
    expect(mapEventToVisualState({ type: 'indexing', file: 'src/extension.ts', progress: 50 })).toBe('working');
  });

  it('mapea success -> success', () => {
    expect(mapEventToVisualState({ type: 'success', message: 'Listo' })).toBe('success');
  });

  it('mapea warning -> warning', () => {
    expect(mapEventToVisualState({ type: 'warning', message: 'Cuidado' })).toBe('warning');
  });

  it('mapea error -> error', () => {
    expect(mapEventToVisualState({ type: 'error', message: 'Falló' })).toBe('error');
  });

  it('mapea seed -> success', () => {
    expect(mapEventToVisualState({ type: 'seed', amount: 3 })).toBe('success');
  });

  it('mapea hide -> sleeping', () => {
    expect(mapEventToVisualState({ type: 'hide' })).toBe('sleeping');
  });

  it('mapea show -> idle', () => {
    expect(mapEventToVisualState({ type: 'show' })).toBe('idle');
  });

  it('cae a idle sin lanzar excepciones para un type no reconocido (Requirement 5.2)', () => {
    const unknownEvent = { type: 'some-future-unrecognized-type' } as unknown as MascotEvent;

    expect(() => mapEventToVisualState(unknownEvent)).not.toThrow();
    expect(mapEventToVisualState(unknownEvent)).toBe('idle');
  });
});

describe('applyVisualState', () => {
  it('aplica la clase mascot-state-<state> correcta al elemento', () => {
    const root = document.createElement('div');

    applyVisualState(root, 'working');

    expect(root.classList.contains(`${MASCOT_STATE_CLASS_PREFIX}working`)).toBe(true);
  });

  it('remueve cualquier clase de estado anterior antes de aplicar la nueva', () => {
    const root = document.createElement('div');

    applyVisualState(root, 'working');
    expect(root.classList.contains(`${MASCOT_STATE_CLASS_PREFIX}working`)).toBe(true);

    applyVisualState(root, 'idle');

    expect(root.classList.contains(`${MASCOT_STATE_CLASS_PREFIX}working`)).toBe(false);
    expect(root.classList.contains(`${MASCOT_STATE_CLASS_PREFIX}idle`)).toBe(true);
  });

  it('nunca deja más de una clase mascot-state-* aplicada tras múltiples llamadas sucesivas', () => {
    const root = document.createElement('div');

    for (const state of MASCOT_VISUAL_STATES) {
      applyVisualState(root, state);

      const appliedStateClasses = Array.from(root.classList).filter((className) =>
        className.startsWith(MASCOT_STATE_CLASS_PREFIX),
      );
      expect(appliedStateClasses).toEqual([`${MASCOT_STATE_CLASS_PREFIX}${state}`]);
    }
  });
});

describe('extractBubbleText', () => {
  it('retorna el message de eventos success/warning/error', () => {
    const success: MascotEvent = { type: 'success', message: 'Listo' };
    const warning: MascotEvent = { type: 'warning', message: 'Cuidado' };
    const error: MascotEvent = { type: 'error', message: 'Falló' };

    expect(extractBubbleText(success)).toBe('Listo');
    expect(extractBubbleText(warning)).toBe('Cuidado');
    expect(extractBubbleText(error)).toBe('Falló');
  });

  it('retorna el file de un evento indexing cuando está presente', () => {
    const event: MascotEvent = { type: 'indexing', file: 'src/extension.ts', progress: 50 };
    expect(extractBubbleText(event)).toBe('src/extension.ts');
  });

  it('retorna undefined para indexing sin file', () => {
    const event: MascotEvent = { type: 'indexing', progress: 50 };
    expect(extractBubbleText(event)).toBeUndefined();
  });

  it('retorna undefined para idle, seed, hide y show', () => {
    expect(extractBubbleText({ type: 'idle' })).toBeUndefined();
    expect(extractBubbleText({ type: 'seed', amount: 3 })).toBeUndefined();
    expect(extractBubbleText({ type: 'hide' })).toBeUndefined();
    expect(extractBubbleText({ type: 'show' })).toBeUndefined();
  });
});

describe('showBubble', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inserta el texto exclusivamente vía textContent, nunca interpretado como HTML (Requirement 6.3)', () => {
    const bubble = document.createElement('div');
    const maliciousText = '<img src=x onerror=alert(1)>';

    showBubble(bubble, maliciousText, BUBBLE_AUTO_HIDE_MS);

    // textContent conserva el texto literal.
    expect(bubble.textContent).toBe(maliciousText);
    // Ningún <img> real fue creado como elemento hijo: textContent escapa
    // el markup, por lo que innerHTML lo muestra como entidades escapadas,
    // no como una etiqueta interpretada.
    expect(bubble.querySelector('img')).toBeNull();
    expect(bubble.innerHTML).not.toContain('<img src=x onerror=alert(1)>');
    expect(bubble.innerHTML).toContain('&lt;img');
  });

  it('pone el texto completo en el atributo title (tooltip, Requirement 6.2)', () => {
    const bubble = document.createElement('div');
    const longText = 'Un mensaje bastante largo que se truncaría visualmente';

    showBubble(bubble, longText, BUBBLE_AUTO_HIDE_MS);

    expect(bubble.title).toBe(longText);
  });

  it('hace visible la burbuja añadiendo la clase de visibilidad', () => {
    const bubble = document.createElement('div');
    showBubble(bubble, 'hola', BUBBLE_AUTO_HIDE_MS);
    expect(bubble.classList.contains(BUBBLE_VISIBLE_CLASS)).toBe(true);
  });

  it('se auto-oculta y limpia textContent/title tras autoHideMs (Requirement 6.4)', () => {
    const bubble = document.createElement('div');
    showBubble(bubble, 'hola', 1000);

    vi.advanceTimersByTime(999);
    expect(bubble.classList.contains(BUBBLE_VISIBLE_CLASS)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(bubble.classList.contains(BUBBLE_VISIBLE_CLASS)).toBe(false);
    expect(bubble.textContent).toBe('');
    expect(bubble.title).toBe('');
  });

  it('cancela el timeout anterior si se llama de nuevo antes de que venza (reset tipo debounce)', () => {
    const bubble = document.createElement('div');

    showBubble(bubble, 'primer mensaje', 1000);
    vi.advanceTimersByTime(900);
    // Segundo mensaje llega antes de que venza el primer timer.
    showBubble(bubble, 'segundo mensaje', 1000);

    // Si el timer viejo no se hubiera cancelado, se ocultaría aquí (900 + 100 = 1000ms desde el primero).
    vi.advanceTimersByTime(100);
    expect(bubble.classList.contains(BUBBLE_VISIBLE_CLASS)).toBe(true);
    expect(bubble.textContent).toBe('segundo mensaje');

    // El nuevo timer vence 1000ms después de la segunda llamada.
    vi.advanceTimersByTime(900);
    expect(bubble.classList.contains(BUBBLE_VISIBLE_CLASS)).toBe(false);
  });
});
