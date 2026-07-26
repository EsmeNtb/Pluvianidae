import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decideSingleInstanceOutcome } from '../../desktop-mascot/src/single-instance';

// Feature: desktop-mascot, Property 4: Instancia única de Electron.
//
// "Para cualquier intento de iniciar un segundo proceso Electron mientras
// uno ya tiene el lock de instancia única, el segundo proceso SHALL
// terminar (app.quit()) sin crear una segunda BrowserWindow visible."
// Validates: Requirements 3.7, 12.5
//
// Nota de alcance: `decideSingleInstanceOutcome` es la extracción mínima y
// pura de la decisión tomada a partir del resultado (ya obtenido) de
// `app.requestSingleInstanceLock()` — vive en su propio módulo,
// `desktop-mascot/src/single-instance.ts`, precisamente para poder
// importarla sin ejecutar el resto de `main.ts` (que corre código a nivel
// de módulo dependiente de `electron`, un módulo no disponible/utilizable
// fuera de un proceso Electron real). No es posible invocar
// `app.requestSingleInstanceLock()` en sí ni construir una `BrowserWindow`
// real en este entorno de pruebas, así que esta prueba cubre la esencia
// de la property: el proceso perdedor (`gotTheLock === false`) siempre
// decide `'quit'` (que en `main.ts` se traduce directamente en
// `app.quit()` sin llegar nunca a la rama que crea la `BrowserWindow`), y
// el ganador (`gotTheLock === true`) siempre decide `'proceed'` (la única
// rama que crea la `BrowserWindow`). La revisión de `main.ts` confirma que
// ninguna otra rama de código entre el resultado del lock y la creación
// de la ventana depende de nada más que este valor booleano.

const NUM_RUNS = 100;

describe('desktop-mascot single-instance lock property tests', () => {
  describe("Property 4: Instancia única de Electron", () => {
    it('returns "quit" if and only if gotTheLock is false, and "proceed" if and only if it is true', () => {
      fc.assert(
        fc.property(fc.boolean(), (gotTheLock) => {
          const outcome = decideSingleInstanceOutcome(gotTheLock);

          expect(outcome === 'quit').toBe(gotTheLock === false);
          expect(outcome === 'proceed').toBe(gotTheLock === true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('never produces an outcome other than "proceed" or "quit"', () => {
      fc.assert(
        fc.property(fc.boolean(), (gotTheLock) => {
          const outcome = decideSingleInstanceOutcome(gotTheLock);
          expect(['proceed', 'quit']).toContain(outcome);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
