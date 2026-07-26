import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeNextBackoff,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from '../../desktop-mascot/src/sse-client';

// Feature: desktop-mascot, Property 3: Backoff de reconexión acotado
// (design.md > "Correctness Properties" / "ALGORITHM maintainConnection").
//
// "Para cualquier caída de la conexión SSE detectada, el cliente SHALL
// reintentar la conexión con backoff exponencial acotado entre
// INITIAL_BACKOFF_MS y MAX_BACKOFF_MS, sin nunca detener el bucle de
// reintento de forma permanente."
//
// Validates: Requirements 3.3, 12.4

const NUM_RUNS = 100;

describe('sse-client property tests', () => {
  describe('Property 3a: computeNextBackoff está siempre acotado y es determinista', () => {
    it('nunca retorna un valor mayor que maxBackoffMs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100000 }),
          fc.integer({ min: 1, max: 100000 }),
          (currentBackoffMs, maxBackoffMs) => {
            const next = computeNextBackoff(currentBackoffMs, maxBackoffMs);
            expect(next).toBeLessThanOrEqual(maxBackoffMs);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('es monótono no decreciente hasta el tope cuando currentBackoffMs <= maxBackoffMs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100000 }),
          fc.integer({ min: 1, max: 100000 }),
          (currentBackoffMs, maxBackoffMs) => {
            // Restringimos al caso currentBackoffMs <= maxBackoffMs: es el
            // caso real que ocurre en maintainConnection, donde backoffMs
            // nunca excede maxBackoffMs de entrada (siempre se acota con
            // min() en la llamada anterior). El caso currentBackoffMs >
            // maxBackoffMs de entrada es un estado que el bucle real nunca
            // produce, así que se excluye explícitamente del arbitrary en
            // vez de asumir un comportamiento no especificado para él.
            fc.pre(currentBackoffMs <= maxBackoffMs);
            const next = computeNextBackoff(currentBackoffMs, maxBackoffMs);
            expect(next).toBeGreaterThanOrEqual(currentBackoffMs);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('es determinista: la misma entrada siempre produce la misma salida', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100000 }),
          fc.integer({ min: 1, max: 100000 }),
          (currentBackoffMs, maxBackoffMs) => {
            const first = computeNextBackoff(currentBackoffMs, maxBackoffMs);
            const second = computeNextBackoff(currentBackoffMs, maxBackoffMs);
            expect(first).toBe(second);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('Property 3b: secuencia de backoff acotada a través de reintentos consecutivos', () => {
    it('cada valor de la secuencia de reintentos consecutivos permanece en [INITIAL_BACKOFF_MS, MAX_BACKOFF_MS]', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 20 }), (numRetries) => {
          let backoffMs = INITIAL_BACKOFF_MS;
          for (let i = 0; i < numRetries; i++) {
            backoffMs = computeNextBackoff(backoffMs, MAX_BACKOFF_MS);
            expect(backoffMs).toBeGreaterThanOrEqual(INITIAL_BACKOFF_MS);
            expect(backoffMs).toBeLessThanOrEqual(MAX_BACKOFF_MS);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('la secuencia eventualmente alcanza y se mantiene en MAX_BACKOFF_MS (nunca se detiene el bucle)', () => {
      // Tras suficientes reintentos consecutivos, backoffMs converge en el
      // tope y permanece ahí indefinidamente (nunca vuelve a crecer sin
      // límite ni el bucle se detiene por alcanzar el tope).
      let backoffMs = INITIAL_BACKOFF_MS;
      const numRetriesToConverge = Math.ceil(Math.log2(MAX_BACKOFF_MS / INITIAL_BACKOFF_MS)) + 1;
      for (let i = 0; i < numRetriesToConverge; i++) {
        backoffMs = computeNextBackoff(backoffMs, MAX_BACKOFF_MS);
      }
      expect(backoffMs).toBe(MAX_BACKOFF_MS);

      // Reintentos adicionales tras la convergencia siguen acotados y
      // estables en el tope, no exceden MAX_BACKOFF_MS.
      for (let i = 0; i < 5; i++) {
        backoffMs = computeNextBackoff(backoffMs, MAX_BACKOFF_MS);
        expect(backoffMs).toBe(MAX_BACKOFF_MS);
      }
    });
  });
});
