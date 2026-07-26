import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  MASCOT_ACTION_TYPES,
  isMascotAction,
  serializeMascotAction,
  deserializeMascotAction,
  type MascotAction,
} from '../../shared/mascot-actions';

// Feature: desktop-mascot, Property 1 (schema portion): Rechazo seguro de
// mensajes inválidos.
//
// "Para cualquier objeto arbitrario, isMascotAction sólo acepta las formas
// exactas de la unión MascotAction (un único campo `action` con un valor
// de la allowlist), rechazando cualquier campo adicional o valor de
// `action` fuera de la lista."
// Validates: Requirements 3.4, 3.5, 4.3, 12.1, 12.2

const NUM_RUNS = 100;

/** A valid MascotAction, generated from the allowlist. */
const validMascotAction: fc.Arbitrary<MascotAction> = fc
  .constantFrom(...MASCOT_ACTION_TYPES)
  .map((action) => ({ action }) as MascotAction);

describe('mascot-actions property tests', () => {
  describe('Property 1: isMascotAction accepts exactly the closed union', () => {
    it('accepts every valid MascotAction shape', () => {
      fc.assert(
        fc.property(validMascotAction, (action) => {
          expect(isMascotAction(action)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('rejects a valid action value with any additional field', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...MASCOT_ACTION_TYPES),
          fc.string({ minLength: 1, maxLength: 10 }).filter((key) => key !== 'action'),
          fc.anything(),
          (action, extraKey, extraValue) => {
            const withExtra: Record<string, unknown> = { action, [extraKey]: extraValue };
            expect(isMascotAction(withExtra)).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('rejects any action value outside MASCOT_ACTION_TYPES', () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => !(MASCOT_ACTION_TYPES as readonly string[]).includes(s)),
          (action) => {
            expect(isMascotAction({ action })).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('rejects arbitrary non-matching objects, primitives, and null/undefined', () => {
      fc.assert(
        fc.property(
          fc.anything().filter((value) => {
            if (typeof value !== 'object' || value === null) return true;
            const record = value as Record<string, unknown>;
            const keys = Object.keys(record);
            if (keys.length !== 1 || keys[0] !== 'action') return true;
            return !(MASCOT_ACTION_TYPES as readonly string[]).includes(record.action as string);
          }),
          (value) => {
            expect(isMascotAction(value)).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('Property: round-trip serialization', () => {
    it('deserializeMascotAction(serializeMascotAction(a)) is structurally equal to a', () => {
      fc.assert(
        fc.property(validMascotAction, (action) => {
          const roundTripped = deserializeMascotAction(serializeMascotAction(action));
          expect(roundTripped).toEqual(action);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('deserializeMascotAction returns undefined for invalid JSON', () => {
      fc.assert(
        fc.property(fc.string(), (raw) => {
          // Only test genuinely malformed JSON strings.
          let isValidJson = true;
          try {
            JSON.parse(raw);
          } catch {
            isValidJson = false;
          }
          if (!isValidJson) {
            expect(deserializeMascotAction(raw)).toBeUndefined();
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('deserializeMascotAction returns undefined for well-formed JSON that is not a MascotAction', () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.array(fc.anything())),
          (value) => {
            const raw = JSON.stringify(value);
            expect(deserializeMascotAction(raw)).toBeUndefined();
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
