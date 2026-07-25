import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { wireMascotToEventBus } from '../../src/presentation/mascot/mascot-webview';
import { EventBus } from '../../src/core/event-bus';
import { IMascotController } from '../../src/presentation/mascot/mascot-controller';
import { MascotAnimation, Seed } from '../../src/core/models';
import { ISeedEngine } from '../../src/modules/seed-engine/seed-engine';

/** Records every animation the controller was asked to play. */
class StubMascotController implements IMascotController {
  public animations: MascotAnimation[] = [];

  show(): void {
    // not exercised by this test
  }

  hide(): void {
    // not exercised by this test
  }

  animate(animation: MascotAnimation): void {
    this.animations.push(animation);
  }

  positionNear(_filePath: string): void {
    // not exercised by this test
  }
}

/**
 * Stub `ISeedEngine` exposing only `getPendingSeeds`, returning an array
 * whose *length* is controlled by the test (contents are irrelevant to
 * `wireMascotToEventBus`, which only reads `.length`).
 */
class StubSeedEngine implements Pick<ISeedEngine, 'getPendingSeeds'> {
  constructor(private pendingCount: number) {}

  setPendingCount(count: number): void {
    this.pendingCount = count;
  }

  getPendingSeeds(): Seed[] {
    return new Array(this.pendingCount) as Seed[];
  }
}

describe('wireMascotToEventBus carrying-seed indicator property tests', () => {
  // Feature: pluvianidae-mvp, Property 21: Mascot carrying-seed indicator
  it('animates carrying-seed if and only if getPendingSeeds().length > 0 on seed:created/seed:updated', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.constantFrom<'seed:created' | 'seed:updated'>('seed:created', 'seed:updated'),
        (pendingCount, eventType) => {
          const eventBus = new EventBus();
          const controller = new StubMascotController();
          const seedEngineSource = new StubSeedEngine(pendingCount);

          const subscription = wireMascotToEventBus(eventBus, controller, seedEngineSource);

          if (eventType === 'seed:created') {
            eventBus.emit({
              type: 'seed:created',
              payload: {
                id: 'seed-id',
                type: 'problema',
                sourceModule: 'dead-code-detector',
                description: 'Hallazgo de prueba',
                state: 'Pendiente',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });
          } else {
            eventBus.emit({
              type: 'seed:updated',
              payload: { id: 'seed-id', newState: 'Pendiente' },
            });
          }

          expect(controller.animations.length).toBeGreaterThan(0);
          const lastAnimation = controller.animations[controller.animations.length - 1];

          if (pendingCount > 0) {
            expect(lastAnimation).toEqual({ type: 'carrying-seed' });
          } else {
            expect(lastAnimation).toEqual({ type: 'idle' });
          }

          subscription.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });
});
