import { describe, it, expect, beforeEach } from 'vitest';
import { Finding } from '../../../src/core/models';
import {
  SeedEngine,
  SeedNotFoundError,
  InvalidSeedTransitionError,
} from '../../../src/modules/seed-engine/seed-engine';

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

describe('SeedEngine', () => {
  let engine: SeedEngine;

  beforeEach(() => {
    engine = new SeedEngine();
  });

  describe('createSeed', () => {
    it('creates a seed with initial state "Pendiente" and all fields copied from the finding', () => {
      const finding = makeFinding();
      const before = new Date();
      const seed = engine.createSeed(finding);
      const after = new Date();

      expect(seed.id).toBeTruthy();
      expect(seed.state).toBe('Pendiente');
      expect(seed.sourceModule).toBe(finding.sourceModule);
      expect(seed.description).toBe(finding.description);
      expect(seed.location).toEqual({ filePath: finding.filePath, line: finding.line, column: 1 });
      expect(seed.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(seed.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(seed.updatedAt).toEqual(seed.createdAt);
    });

    it('classifies a finding with confidence set as "problema"', () => {
      const seed = engine.createSeed(makeFinding({ type: 'unused-import', confidence: 'alto' }));
      expect(seed.type).toBe('problema');
    });

    it('classifies a finding without confidence as "recomendación" by default', () => {
      const seed = engine.createSeed(makeFinding({ type: 'general-suggestion', confidence: undefined }));
      expect(seed.type).toBe('recomendación');
    });

    it('classifies a finding whose type mentions "tip" as "tip"', () => {
      const seed = engine.createSeed(makeFinding({ type: 'style-tip', confidence: undefined }));
      expect(seed.type).toBe('tip');
    });

    it('classifies a finding whose type mentions "review" as "review"', () => {
      const seed = engine.createSeed(makeFinding({ type: 'pre-commit-review', confidence: undefined }));
      expect(seed.type).toBe('review');
    });

    it('omits location when the finding has no filePath/line', () => {
      const seed = engine.createSeed(makeFinding({ filePath: undefined, line: undefined }));
      expect(seed.location).toBeUndefined();
    });

    it('sets suggestedAction from the finding when present', () => {
      const seed = engine.createSeed(makeFinding({ suggestedAction: 'eliminar' }));
      expect(seed.suggestedAction).toBe('eliminar');
    });
  });

  describe('updateState — valid transitions', () => {
    it('allows Pendiente -> En revisión', () => {
      const seed = engine.createSeed(makeFinding());
      const updated = engine.updateState(seed.id, 'En revisión');
      expect(updated.state).toBe('En revisión');
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(seed.updatedAt.getTime());
    });

    it('allows Pendiente -> Resuelta', () => {
      const seed = engine.createSeed(makeFinding());
      const updated = engine.updateState(seed.id, 'Resuelta');
      expect(updated.state).toBe('Resuelta');
    });

    it('allows Pendiente -> Ignorada', () => {
      const seed = engine.createSeed(makeFinding());
      const updated = engine.updateState(seed.id, 'Ignorada');
      expect(updated.state).toBe('Ignorada');
    });

    it('allows En revisión -> Resuelta', () => {
      const seed = engine.createSeed(makeFinding());
      engine.updateState(seed.id, 'En revisión');
      const updated = engine.updateState(seed.id, 'Resuelta');
      expect(updated.state).toBe('Resuelta');
    });

    it('allows En revisión -> Ignorada', () => {
      const seed = engine.createSeed(makeFinding());
      engine.updateState(seed.id, 'En revisión');
      const updated = engine.updateState(seed.id, 'Ignorada');
      expect(updated.state).toBe('Ignorada');
    });
  });

  describe('updateState — invalid transitions', () => {
    it('rejects Resuelta -> anything (terminal state)', () => {
      const seed = engine.createSeed(makeFinding());
      engine.updateState(seed.id, 'Resuelta');
      expect(() => engine.updateState(seed.id, 'En revisión')).toThrow(InvalidSeedTransitionError);
    });

    it('rejects Ignorada -> anything (terminal state)', () => {
      const seed = engine.createSeed(makeFinding());
      engine.updateState(seed.id, 'Ignorada');
      expect(() => engine.updateState(seed.id, 'Resuelta')).toThrow(InvalidSeedTransitionError);
    });

    it('rejects Pendiente -> Pendiente (self transition)', () => {
      const seed = engine.createSeed(makeFinding());
      expect(() => engine.updateState(seed.id, 'Pendiente')).toThrow(InvalidSeedTransitionError);
    });

    it('rejects En revisión -> Pendiente', () => {
      const seed = engine.createSeed(makeFinding());
      engine.updateState(seed.id, 'En revisión');
      expect(() => engine.updateState(seed.id, 'Pendiente')).toThrow(InvalidSeedTransitionError);
    });

    it('throws SeedNotFoundError when updating an unknown id', () => {
      expect(() => engine.updateState('non-existent-id', 'En revisión')).toThrow(SeedNotFoundError);
    });
  });

  describe('getPendingSeeds', () => {
    it('returns only seeds currently in state "Pendiente"', () => {
      const s1 = engine.createSeed(makeFinding({ description: 's1' }));
      const s2 = engine.createSeed(makeFinding({ description: 's2' }));
      const s3 = engine.createSeed(makeFinding({ description: 's3' }));
      engine.updateState(s2.id, 'Resuelta');

      const pending = engine.getPendingSeeds();
      const pendingIds = pending.map((s) => s.id);

      expect(pendingIds).toContain(s1.id);
      expect(pendingIds).toContain(s3.id);
      expect(pendingIds).not.toContain(s2.id);
      expect(pending.every((s) => s.state === 'Pendiente')).toBe(true);
    });
  });

  describe('getSeedDetail', () => {
    it('returns the seed matching the given id', () => {
      const seed = engine.createSeed(makeFinding());
      expect(engine.getSeedDetail(seed.id)).toEqual(seed);
    });

    it('returns undefined for an unknown id', () => {
      expect(engine.getSeedDetail('non-existent-id')).toBeUndefined();
    });
  });

  describe('getAllSeeds', () => {
    it('returns every created seed regardless of state', () => {
      const s1 = engine.createSeed(makeFinding({ description: 's1' }));
      const s2 = engine.createSeed(makeFinding({ description: 's2' }));
      engine.updateState(s2.id, 'Ignorada');

      const all = engine.getAllSeeds();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.id)).toEqual(expect.arrayContaining([s1.id, s2.id]));
    });
  });
});
