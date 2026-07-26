import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  getDefaultPosition,
  isPositionWithinAnyDisplay,
  resolveInitialPosition,
  type WorkArea,
  type WindowPosition,
} from '../../desktop-mascot/src/window-state';

// Feature: desktop-mascot, Property 6: Posición de ventana siempre dentro
// de un display válido.
//
// "Para cualquier posición de ventana {x, y} persistida que quede fuera de
// todos los displays actualmente conectados (screen.getAllDisplays()), la
// ventana SHALL usar la posición por defecto (esquina inferior derecha del
// display primario) en vez de la posición guardada."
// Validates: Requirements 1.9, 12.9, 13.7

const NUM_RUNS = 100;

/** Genera un WorkArea con dimensiones razonables. */
const workArea: fc.Arbitrary<WorkArea> = fc.record({
  x: fc.integer({ min: -10000, max: 10000 }),
  y: fc.integer({ min: -10000, max: 10000 }),
  width: fc.integer({ min: 1, max: 4000 }),
  height: fc.integer({ min: 1, max: 4000 }),
});

const workAreaList = fc.array(workArea, { minLength: 1, maxLength: 5 });

/**
 * Posición garantizada por construcción a estar fuera de cualquier display
 * razonable: usa coordenadas extremas, muy por fuera del rango generado por
 * `workArea` (que está acotado a [-10000, 10000] para x/y y [1, 4000] para
 * width/height, cuyo borde derecho/inferior máximo es 14000).
 */
const farOutsidePosition: fc.Arbitrary<WindowPosition> = fc.record({
  x: fc.integer({ min: 100000, max: 200000 }),
  y: fc.integer({ min: 100000, max: 200000 }),
});

describe('window-state property tests', () => {
  describe('Property 6: posición fuera de todos los displays -> posición por defecto', () => {
    it('resolveInitialPosition retorna getDefaultPosition(primary) cuando la posición guardada está fuera de todos los displays', () => {
      fc.assert(
        fc.property(
          workArea,
          workAreaList,
          farOutsidePosition,
          (primary, displays, savedPosition) => {
            // Precondición de la propiedad: la posición generada debe estar
            // efectivamente fuera de todos los displays generados.
            fc.pre(!isPositionWithinAnyDisplay(savedPosition, displays));

            const resolved = resolveInitialPosition(savedPosition, primary, displays);
            expect(resolved).toEqual(getDefaultPosition(primary));
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('resolveInitialPosition retorna la posición guardada cuando cae dentro de al menos un display', () => {
      fc.assert(
        fc.property(
          workArea,
          workAreaList,
          fc.nat(),
          (primary, displays, pickIndexRaw) => {
            const pickIndex = pickIndexRaw % displays.length;
            const target = displays[pickIndex];

            // Construye una posición deliberadamente dentro del display
            // elegido: esquina superior izquierda + offset dentro del
            // rango [0, width) / [0, height).
            const savedPosition: WindowPosition = {
              x: target.x,
              y: target.y,
            };

            expect(isPositionWithinAnyDisplay(savedPosition, displays)).toBe(true);

            const resolved = resolveInitialPosition(savedPosition, primary, displays);
            expect(resolved).toEqual(savedPosition);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('Property: isPositionWithinAnyDisplay rechaza coordenadas no finitas', () => {
    it('retorna false para cualquier posición con x o y no finitos, sin importar los displays', () => {
      const nonFinite = fc.constantFrom(NaN, Infinity, -Infinity);
      const finiteCoord = fc.integer({ min: -10000, max: 10000 });

      const positionWithNonFiniteAxis: fc.Arbitrary<WindowPosition> = fc.oneof(
        fc.record({ x: nonFinite, y: finiteCoord }),
        fc.record({ x: finiteCoord, y: nonFinite }),
        fc.record({ x: nonFinite, y: nonFinite }),
      );

      fc.assert(
        fc.property(positionWithNonFiniteAxis, workAreaList, (position, displays) => {
          expect(isPositionWithinAnyDisplay(position, displays)).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
