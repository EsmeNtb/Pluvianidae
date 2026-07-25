import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { EventBus, PluvianidaeEvent } from '../../src/core/event-bus';

/**
 * Arbitrary generator for `indexing:progress` events. This event type is
 * used as the "workhorse" event for these ordering properties because its
 * payload carries a numeric `current` field that's convenient to assert on,
 * but the properties below only care about ORDER and COUNT, not payload
 * shape, so any single event type would do.
 */
const indexingProgressEventArbitrary: fc.Arbitrary<PluvianidaeEvent> = fc
  .record({
    current: fc.integer({ min: 0, max: 1_000_000 }),
    total: fc.integer({ min: 0, max: 1_000_000 }),
    currentFile: fc.string(),
  })
  .map((payload) => ({ type: 'indexing:progress' as const, payload }));

describe('EventBus property tests', () => {
  // Feature: pluvianidae-mvp, Property 22: Animation queue ordering
  // (Event-Bus-level framing: "Handlers registered for a given event type
  // are invoked in registration order, and events are processed in
  // emission order (synchronous dispatch)." This is the underlying
  // guarantee that the Mascota's animation queue relies on.)
  it('delivers events to a single handler in exactly emission order, with none dropped or duplicated', () => {
    fc.assert(
      fc.property(
        fc.array(indexingProgressEventArbitrary, { minLength: 0, maxLength: 200 }),
        (events) => {
          const bus = new EventBus();
          const received: PluvianidaeEvent[] = [];

          bus.on('indexing:progress', (event) => {
            received.push(event);
          });

          for (const event of events) {
            bus.emit(event);
          }

          // Same count: nothing dropped, nothing duplicated.
          expect(received.length).toBe(events.length);
          // Same order: emission order preserved exactly.
          expect(received).toEqual(events);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: pluvianidae-mvp, Property 22: Animation queue ordering
  it('delivers the full ordered sequence independently to every handler registered for the same event type', () => {
    fc.assert(
      fc.property(
        fc.array(indexingProgressEventArbitrary, { minLength: 0, maxLength: 200 }),
        fc.integer({ min: 2, max: 5 }),
        (events, handlerCount) => {
          const bus = new EventBus();
          const receivedByHandler: PluvianidaeEvent[][] = Array.from(
            { length: handlerCount },
            () => []
          );

          for (let i = 0; i < handlerCount; i++) {
            const bucket = receivedByHandler[i];
            bus.on('indexing:progress', (event) => {
              bucket.push(event);
            });
          }

          for (const event of events) {
            bus.emit(event);
          }

          for (const bucket of receivedByHandler) {
            expect(bucket.length).toBe(events.length);
            expect(bucket).toEqual(events);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
