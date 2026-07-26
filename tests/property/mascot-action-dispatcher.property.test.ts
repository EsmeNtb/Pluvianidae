import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { createMascotActionDispatcher, ExecuteVsCodeCommand } from '../../src/services/mascot-action-dispatcher';
import { DesktopMascotManager } from '../../src/services/desktop-mascot-manager';
import { MASCOT_ACTION_TYPES, isMascotAction, type MascotAction } from '../../shared/mascot-actions';

// Feature: desktop-mascot, tasks.md 11.3.
//
// Property 7 (design.md > "Correctness Properties"): Allowlist estricta
// de acciones.
//
// "Para cualquier valor de `action` recibido en `POST /actions` que no
// sea uno de los 6 literales de `MascotAction`, el dispatcher SHALL
// rechazar la petición sin ejecutar ningún comando de VS Code."
// **Validates: Requirements 7.2, 9.5, 12.10**

const NUM_RUNS = 100;

function createFakeManager(): { hide: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; manager: DesktopMascotManager } {
  const hide = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const manager = { hide, stop } as unknown as DesktopMascotManager;
  return { hide, stop, manager };
}

/** A valid MascotAction, generated from the allowlist (same approach as mascot-actions.property.test.ts). */
const validMascotAction: fc.Arbitrary<MascotAction> = fc
  .constantFrom(...MASCOT_ACTION_TYPES)
  .map((action) => ({ action }) as MascotAction);

/**
 * Arbitrary invalid inputs: reuses the same generation strategy as
 * `tests/property/mascot-actions.property.test.ts` for values that do
 * NOT satisfy `isMascotAction` — a valid action value plus an extra
 * field, an `action` value outside `MASCOT_ACTION_TYPES`, and arbitrary
 * non-matching objects/primitives (including `null`/`undefined`).
 */
const invalidActionWithExtraField: fc.Arbitrary<unknown> = fc
  .tuple(
    fc.constantFrom(...MASCOT_ACTION_TYPES),
    fc.string({ minLength: 1, maxLength: 10 }).filter((key) => key !== 'action'),
    fc.anything(),
  )
  .map(([action, extraKey, extraValue]) => ({ action, [extraKey]: extraValue }));

const invalidActionValue: fc.Arbitrary<unknown> = fc
  .string()
  .filter((s) => !(MASCOT_ACTION_TYPES as readonly string[]).includes(s))
  .map((action) => ({ action }));

const arbitraryNonMatchingValue: fc.Arbitrary<unknown> = fc.anything().filter((value) => {
  if (typeof value !== 'object' || value === null) return true;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'action') return true;
  return !(MASCOT_ACTION_TYPES as readonly string[]).includes(record.action as string);
});

const invalidAction: fc.Arbitrary<unknown> = fc.oneof(
  invalidActionWithExtraField,
  invalidActionValue,
  arbitraryNonMatchingValue,
);

describe('mascot-action-dispatcher property tests', () => {
  describe('Property 7: Allowlist estricta de acciones', () => {
    it('rechaza cualquier valor que no satisfaga isMascotAction sin ejecutar comandos ni efectos locales', async () => {
      await fc.assert(
        fc.asyncProperty(invalidAction, async (value) => {
          // Guard: only exercise genuinely invalid inputs (mirrors the
          // filter discipline of mascot-actions.property.test.ts).
          fc.pre(!isMascotAction(value));

          const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
          const { manager, hide, stop } = createFakeManager();
          const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

          await expect(dispatcher.dispatch(value as unknown as MascotAction)).resolves.toBeUndefined();

          expect(executeCommand).not.toHaveBeenCalled();
          expect(hide).not.toHaveBeenCalled();
          expect(stop).not.toHaveBeenCalled();
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('para cualquier acción válida, dispatch invoca como máximo una vía de efecto', async () => {
      await fc.assert(
        fc.asyncProperty(validMascotAction, async (action) => {
          const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
          const { manager, hide, stop } = createFakeManager();
          const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

          await dispatcher.dispatch(action);

          const totalInvocations =
            (executeCommand as ReturnType<typeof vi.fn>).mock.calls.length + hide.mock.calls.length + stop.mock.calls.length;

          // mute-messages invokes no effect at all; the other 5 actions
          // invoke exactly one (either executeCommand, hide, or stop).
          expect(totalInvocations).toBeLessThanOrEqual(1);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
