import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Finding, Seed, SeedState, VALID_SEED_TRANSITIONS } from '../../src/core/models';
import { SeedEngine, SeedNotFoundError, InvalidSeedTransitionError } from '../../src/modules/seed-engine/seed-engine';

/**
 * Arbitrary generator for `Finding` objects. `type` is deliberately generated
 * from a mix of free-form strings and strings explicitly containing "review"
 * or "tip" (case-varied) so the classification heuristic in
 * `classifyFindingType` (review > tip > confidence-set > default) gets
 * exercised across all four `Seed.type` outcomes.
 */
const findingArbitrary: fc.Arbitrary<Finding> = fc
  .record({
    type: fc.oneof(
      fc.constantFrom(
        'unused-import',
        'commented-code',
        'endpoint-mismatch',
        'secret',
        'general-suggestion',
        'Review-step',
        'REVIEW',
        'pre-commit-review',
        'style-tip',
        'TIP-info',
        'Tip'
      ),
      fc.string()
    ),
    sourceModule: fc.string({ minLength: 1, maxLength: 30 }),
    filePath: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    line: fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: undefined }),
    description: fc.string({ minLength: 1, maxLength: 200 }),
    suggestedAction: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    confidence: fc.option(fc.constantFrom('alto', 'medio', 'bajo') as fc.Arbitrary<'alto' | 'medio' | 'bajo'>, {
      nil: undefined,
    }),
  })
  .map((finding) => {
    // `fc.option` with `nil: undefined` can still produce a `filePath`
    // without a `line` (or vice versa) independently, which is fine — the
    // property below asserts `location` iff BOTH are defined.
    return finding as Finding;
  });

function expectedSeedType(finding: Finding): Seed['type'] {
  const type = finding.type.toLowerCase();
  if (type.includes('review')) {
    return 'review';
  }
  if (type.includes('tip')) {
    return 'tip';
  }
  if (finding.confidence) {
    return 'problema';
  }
  return 'recomendación';
}

describe('SeedEngine.createSeed property tests', () => {
  // Feature: pluvianidae-mvp, Property 19: Seed creation completeness
  it('always creates a seed with state "Pendiente", a unique id, correctly classified type, matching location, and fields copied through unchanged', () => {
    fc.assert(
      fc.property(fc.array(findingArbitrary, { minLength: 1, maxLength: 50 }), (findings) => {
        const engine = new SeedEngine();
        const seeds = findings.map((finding) => engine.createSeed(finding));

        // Initial state is always "Pendiente".
        for (const seed of seeds) {
          expect(seed.state).toBe('Pendiente');
        }

        // Every seed id is unique across the run.
        const ids = seeds.map((seed) => seed.id);
        expect(new Set(ids).size).toBe(ids.length);

        for (let i = 0; i < findings.length; i++) {
          const finding = findings[i];
          const seed = seeds[i];

          // Type classification heuristic (review > tip > confidence > default).
          expect(seed.type).toBe(expectedSeedType(finding));

          // Location defined iff both filePath and line are defined on the finding.
          if (finding.filePath !== undefined && finding.line !== undefined) {
            expect(seed.location).toEqual({
              filePath: finding.filePath,
              line: finding.line,
              column: 1,
            });
          } else {
            expect(seed.location).toBeUndefined();
          }

          // Fields copied through unchanged.
          expect(seed.description).toBe(finding.description);
          expect(seed.suggestedAction).toBe(finding.suggestedAction);
          expect(seed.sourceModule).toBe(finding.sourceModule);

          // Creation timestamp is present.
          expect(seed.createdAt).toBeInstanceOf(Date);
          expect(seed.updatedAt).toEqual(seed.createdAt);
        }
      }),
      { numRuns: 100 }
    );
  });
});

const ALL_SEED_STATES: SeedState[] = ['Pendiente', 'En revisión', 'Resuelta', 'Ignorada'];

const seedStateArbitrary: fc.Arbitrary<SeedState> = fc.constantFrom(...ALL_SEED_STATES);

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'unused-import',
    sourceModule: 'dead-code-detector',
    filePath: 'src/foo.ts',
    line: 10,
    description: 'El import "bar" no se utiliza en este archivo.',
    confidence: 'alto',
    ...overrides,
  };
}

describe('SeedEngine state machine property tests', () => {
  // Feature: pluvianidae-mvp, Property 18: Seed state machine validity
  it('permits a transition if and only if it is listed in VALID_SEED_TRANSITIONS, and leaves the seed unchanged otherwise', () => {
    fc.assert(
      fc.property(seedStateArbitrary, seedStateArbitrary, (fromState, toState) => {
        const engine = new SeedEngine();
        const seed = engine.createSeed(makeFinding());

        // Drive the freshly-created seed (always starts as 'Pendiente')
        // into `fromState` so the transition under test can be attempted
        // from any of the four states, not just the initial one. This is
        // only possible when `fromState` is itself reachable in one hop
        // from 'Pendiente' (or is 'Pendiente' itself) — for `fromState`
        // values that require two hops ('Resuelta'/'Ignorada' are
        // terminal, so nothing beyond them is reachable), the sequence
        // below always succeeds because VALID_SEED_TRANSITIONS only ever
        // needs at most one intermediate hop through 'En revisión'.
        if (fromState !== 'Pendiente') {
          if (VALID_SEED_TRANSITIONS['Pendiente'].includes(fromState)) {
            engine.updateState(seed.id, fromState);
          } else {
            // Unreachable state from 'Pendiente' directly: route through
            // 'En revisión' when possible.
            engine.updateState(seed.id, 'En revisión');
            if (fromState !== 'En revisión') {
              engine.updateState(seed.id, fromState);
            }
          }
        }

        const isValid = VALID_SEED_TRANSITIONS[fromState].includes(toState);

        if (isValid) {
          const updated = engine.updateState(seed.id, toState);
          expect(updated.state).toBe(toState);
          expect(engine.getSeedDetail(seed.id)!.state).toBe(toState);
        } else {
          expect(() => engine.updateState(seed.id, toState)).toThrow(InvalidSeedTransitionError);
          // The seed's state must remain unchanged after a rejected
          // transition.
          expect(engine.getSeedDetail(seed.id)!.state).toBe(fromState);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: pluvianidae-mvp, Property 18: Seed state machine validity
  it('throws SeedNotFoundError when updateState is called with an unknown seed id, regardless of target state', () => {
    fc.assert(
      fc.property(fc.uuid(), seedStateArbitrary, (unknownId, targetState) => {
        const engine = new SeedEngine();
        // Create an unrelated seed so the store isn't empty, then attempt
        // to update a different (unknown) id.
        const seed = engine.createSeed(makeFinding());
        fc.pre(unknownId !== seed.id);

        expect(() => engine.updateState(unknownId, targetState)).toThrow(SeedNotFoundError);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: pluvianidae-mvp, Property 18: Seed state machine validity
  it('keeps every seed in one of the four valid states after any sequence of transition attempts', () => {
    fc.assert(
      fc.property(fc.array(seedStateArbitrary, { minLength: 0, maxLength: 10 }), (attemptedStates) => {
        const engine = new SeedEngine();
        const seed = engine.createSeed(makeFinding());

        for (const targetState of attemptedStates) {
          const current = engine.getSeedDetail(seed.id)!.state;
          if (VALID_SEED_TRANSITIONS[current].includes(targetState)) {
            engine.updateState(seed.id, targetState);
          } else {
            expect(() => engine.updateState(seed.id, targetState)).toThrow(InvalidSeedTransitionError);
          }
        }

        expect(ALL_SEED_STATES).toContain(engine.getSeedDetail(seed.id)!.state);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20: Pending seed count consistency
// ---------------------------------------------------------------------------

import { formatPendingCountText } from '../../src/presentation/seed-basket-view';

/** A small alphabet of operations used to build arbitrary seed-lifecycle sequences. */
type SeedOp = { kind: 'create'; finding: Finding } | { kind: 'transition'; seedIndex: number; newState: SeedState };

const seedOpArbitrary: fc.Arbitrary<SeedOp> = fc.oneof(
  fc.record({ kind: fc.constant('create' as const), finding: findingArbitrary }),
  fc.record({
    kind: fc.constant('transition' as const),
    seedIndex: fc.nat({ max: 49 }),
    newState: seedStateArbitrary,
  }),
);

describe('SeedEngine pending count property tests', () => {
  // Feature: pluvianidae-mvp, Property 20: Pending seed count consistency
  it('getPendingSeeds().length always equals the exact number of seeds currently in state "Pendiente", for any sequence of creations and state transitions', () => {
    fc.assert(
      fc.property(fc.array(seedOpArbitrary, { minLength: 0, maxLength: 60 }), (ops) => {
        const engine = new SeedEngine();
        const createdIds: string[] = [];

        for (const op of ops) {
          if (op.kind === 'create') {
            const seed = engine.createSeed(op.finding);
            createdIds.push(seed.id);
          } else {
            if (createdIds.length === 0) {
              continue;
            }
            const targetId = createdIds[op.seedIndex % createdIds.length];
            const current = engine.getSeedDetail(targetId)!.state;
            if (VALID_SEED_TRANSITIONS[current].includes(op.newState)) {
              engine.updateState(targetId, op.newState);
            }
            // Invalid transitions are simply skipped here (already covered
            // by Property 18's tests) — this property is only concerned
            // with the pending count staying consistent regardless.
          }
        }

        const pendingFromGetter = engine.getPendingSeeds();
        const pendingFromFilter = engine.getAllSeeds().filter((s) => s.state === 'Pendiente');

        // Cross-check against a manual filter over getAllSeeds().
        expect(pendingFromGetter.length).toBe(pendingFromFilter.length);
        expect(new Set(pendingFromGetter.map((s) => s.id))).toEqual(new Set(pendingFromFilter.map((s) => s.id)));

        // Every seed returned by getPendingSeeds() is genuinely "Pendiente",
        // and every "Pendiente" seed in getAllSeeds() is present in
        // getPendingSeeds() (i.e. an exact match, not just equal counts).
        const allSeeds = engine.getAllSeeds();
        const expectedPendingIds = new Set(allSeeds.filter((s) => s.state === 'Pendiente').map((s) => s.id));
        const actualPendingIds = new Set(pendingFromGetter.map((s) => s.id));
        expect(actualPendingIds).toEqual(expectedPendingIds);

        // The formatted pending-count text always agrees with the exact count.
        const count = pendingFromGetter.length;
        const text = formatPendingCountText(count);
        if (count === 0) {
          expect(text).toBe('0 semillas pendientes');
        } else if (count === 1) {
          expect(text).toBe('1 semilla pendiente');
        } else {
          expect(text).toBe(`${count} semillas pendientes`);
        }
      }),
      { numRuns: 100 },
    );
  });
});
