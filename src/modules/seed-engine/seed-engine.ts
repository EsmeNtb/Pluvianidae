/**
 * Motor de Semillas (Seed Engine) module.
 *
 * Converts `Finding`s emitted by analysis modules (Dead Code Detector,
 * Frontend-Backend Comparator, Pre-Commit Reviewer, etc.) into `Seed`s, and
 * manages each `Seed`'s lifecycle through the state machine defined by
 * `VALID_SEED_TRANSITIONS` in `core/models.ts`. See design.md > "10. Motor
 * de Semillas (`modules/seed-engine/`)" and requirements.md > Requirement 9
 * (9.1, 9.2, 9.3, 9.4).
 *
 * This module is a pure in-memory implementation: seeds live only for the
 * duration of the session. Persisting seeds to disk (with user consent) is
 * the responsibility of `seed-store.ts` (task 13.2), which is expected to
 * wrap or extend this engine — it is intentionally kept out of scope here.
 *
 * ## `Finding.type` → `Seed.type` mapping heuristic
 *
 * `Finding.type` is a generic `string` — individual detector modules use
 * their own free-form type strings (e.g. `'unused-import'`,
 * `'commented-code'`, `'endpoint-mismatch'`, `'secret'`...). `Seed.type`,
 * however, is a closed union of four literals
 * (`'recomendación' | 'tip' | 'problema' | 'review'`) that design.md does
 * not define an exact translation table for. This implementation uses the
 * following documented heuristic, applied in order:
 *
 *   1. If `finding.type` (case-insensitively) contains `"review"` →
 *      `'review'`. Findings explicitly about a review step/output map most
 *      naturally onto this category.
 *   2. Else if `finding.type` (case-insensitively) contains `"tip"` →
 *      `'tip'`. Reserved for lightweight, purely informational findings a
 *      module may choose to label this way.
 *   3. Else if `finding.confidence` is set (`'alto' | 'medio' | 'bajo'`) →
 *      `'problema'`. A `confidence` level is only ever attached to findings
 *      that represent a concretely detected issue in the code (dead code,
 *      secrets, mismatches, etc. — see `DeadCodeFinding`,
 *      `PreCommitFinding`), so its presence is a reliable signal that the
 *      finding describes a *problem*, not a general suggestion.
 *   4. Otherwise → `'recomendación'`. The default/fallback bucket for
 *      findings that don't carry a confidence signal and aren't explicitly
 *      tagged tip/review — e.g. general suggestions from README generation
 *      or repository explanation flows.
 *
 * This is a pragmatic MVP classification, not a strict requirement from
 * design.md (which leaves the exact mapping unspecified) — documented here
 * so the rule is easy to find and revisit.
 *
 * ## Seed `id` generation
 *
 * Each seed gets a unique `id` via `crypto.randomUUID()` (Node's built-in
 * `crypto` module, available without adding a dependency), which is the
 * simplest robust choice for uniqueness within a session.
 */

import { randomUUID } from 'crypto';
import { Finding, Seed, SeedState, SymbolLocation, VALID_SEED_TRANSITIONS } from '../../core/models';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ISeedEngine {
  createSeed(finding: Finding): Seed;
  updateState(seedId: string, newState: SeedState): Seed;
  getPendingSeeds(): Seed[];
  getSeedDetail(seedId: string): Seed | undefined;
  getAllSeeds(): Seed[];
}

/**
 * Thrown by `updateState` when `seedId` doesn't match any known seed.
 * Follows the house error style used elsewhere (e.g. `SymbolNotFoundError`
 * in `reference-analyzer.ts`).
 */
export class SeedNotFoundError extends Error {
  constructor(seedId: string) {
    super(`No se encontró la Semilla con id "${seedId}".`);
    this.name = 'SeedNotFoundError';
  }
}

/**
 * Thrown by `updateState` when the requested transition is not permitted
 * by `VALID_SEED_TRANSITIONS` (requirements.md 9.4: "Reject invalid
 * transitions" — explicit rejection rather than a silent no-op).
 */
export class InvalidSeedTransitionError extends Error {
  constructor(seedId: string, currentState: SeedState, newState: SeedState) {
    super(
      `Transición inválida para la Semilla "${seedId}": no se puede pasar de ` +
        `"${currentState}" a "${newState}". Transiciones válidas desde ` +
        `"${currentState}": ${VALID_SEED_TRANSITIONS[currentState].join(', ') || '(ninguna, estado terminal)'}.`,
    );
    this.name = 'InvalidSeedTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SeedEngine implements ISeedEngine {
  /** In-memory store, keyed by seed id. Preserves creation (insertion) order. */
  private readonly seeds = new Map<string, Seed>();

  createSeed(finding: Finding): Seed {
    const now = new Date();
    const seed: Seed = {
      id: randomUUID(),
      type: classifyFindingType(finding),
      sourceModule: finding.sourceModule,
      location: buildLocation(finding),
      description: finding.description,
      suggestedAction: finding.suggestedAction,
      state: 'Pendiente',
      createdAt: now,
      updatedAt: now,
    };

    this.seeds.set(seed.id, seed);
    return seed;
  }

  updateState(seedId: string, newState: SeedState): Seed {
    const seed = this.seeds.get(seedId);
    if (!seed) {
      throw new SeedNotFoundError(seedId);
    }

    const allowedTransitions = VALID_SEED_TRANSITIONS[seed.state];
    if (!allowedTransitions.includes(newState)) {
      throw new InvalidSeedTransitionError(seedId, seed.state, newState);
    }

    const updatedSeed: Seed = {
      ...seed,
      state: newState,
      updatedAt: new Date(),
    };
    this.seeds.set(seedId, updatedSeed);
    return updatedSeed;
  }

  getPendingSeeds(): Seed[] {
    return this.getAllSeeds().filter((seed) => seed.state === 'Pendiente');
  }

  getSeedDetail(seedId: string): Seed | undefined {
    return this.seeds.get(seedId);
  }

  getAllSeeds(): Seed[] {
    return [...this.seeds.values()];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** See the module-level doc comment's "`Finding.type` → `Seed.type` mapping heuristic" section. */
function classifyFindingType(finding: Finding): Seed['type'] {
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

/**
 * Builds `Seed.location` from `finding.filePath`/`finding.line` when both
 * are present. `Finding` has no `column`, so it defaults to `1`, matching
 * the 1-indexed convention used elsewhere for synthetic locations (e.g.
 * `dead-code-detector.ts`'s orphan-file finding uses `line: 1`).
 */
function buildLocation(finding: Finding): SymbolLocation | undefined {
  if (finding.filePath === undefined || finding.line === undefined) {
    return undefined;
  }
  return { filePath: finding.filePath, line: finding.line, column: 1 };
}
