import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Seed } from '../../../src/core/models';
import { ISeedEngine } from '../../../src/modules/seed-engine/seed-engine';
import {
  SeedBasketTreeDataProvider,
  formatPendingCountText,
  formatSeedDetail,
  formatTransitionButtonLabel,
  getTransitionButtons,
  truncateLabel,
} from '../../../src/presentation/seed-basket-view';

function makeSeed(overrides: Partial<Seed> = {}): Seed {
  const now = new Date();
  return {
    id: 'seed-1',
    type: 'problema',
    sourceModule: 'dead-code-detector',
    location: { filePath: 'src/foo.ts', line: 10, column: 1 },
    description: 'El import "bar" no se utiliza en este archivo.',
    suggestedAction: 'eliminar',
    state: 'Pendiente',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Minimal `ISeedEngine` stub: only `getPendingSeeds` is needed by this view. */
class StubSeedEngine implements ISeedEngine {
  constructor(private readonly seeds: Seed[]) {}

  createSeed(): Seed {
    throw new Error('not used by this view');
  }
  updateState(): Seed {
    throw new Error('not used by this view');
  }
  getPendingSeeds(): Seed[] {
    return this.seeds.filter((s) => s.state === 'Pendiente');
  }
  getSeedDetail(seedId: string): Seed | undefined {
    return this.seeds.find((s) => s.id === seedId);
  }
  getAllSeeds(): Seed[] {
    return this.seeds;
  }
}

describe('truncateLabel', () => {
  it('returns the text unchanged when within the max length', () => {
    expect(truncateLabel('short description', 60)).toBe('short description');
  });

  it('truncates and appends an ellipsis when longer than the max length', () => {
    const long = 'a'.repeat(80);
    const truncated = truncateLabel(long, 60);
    expect(truncated.length).toBe(60);
    expect(truncated.endsWith('…')).toBe(true);
  });
});

describe('formatPendingCountText', () => {
  it('shows "0 semillas pendientes" when there are no pending seeds', () => {
    expect(formatPendingCountText(0)).toBe('0 semillas pendientes');
  });

  it('uses singular wording for exactly one pending seed', () => {
    expect(formatPendingCountText(1)).toBe('1 semilla pendiente');
  });

  it('uses plural wording for more than one pending seed', () => {
    expect(formatPendingCountText(3)).toBe('3 semillas pendientes');
  });
});

describe('formatSeedDetail', () => {
  it('includes description, location, and suggested action when all are present', () => {
    const seed = makeSeed();
    const detail = formatSeedDetail(seed);

    expect(detail).toContain(seed.description);
    expect(detail).toContain('src/foo.ts:10');
    expect(detail).toContain('eliminar');
  });

  it('gracefully omits the location line when the seed has no location', () => {
    const seed = makeSeed({ location: undefined });
    const detail = formatSeedDetail(seed);

    expect(detail).toContain(seed.description);
    expect(detail).not.toContain('Ubicación');
  });

  it('gracefully omits the suggested action line when the seed has none', () => {
    const seed = makeSeed({ suggestedAction: undefined });
    const detail = formatSeedDetail(seed);

    expect(detail).not.toContain('Acción sugerida');
  });
});

describe('formatTransitionButtonLabel', () => {
  it('maps "En revisión" to "Marcar en revisión"', () => {
    expect(formatTransitionButtonLabel('En revisión')).toBe('Marcar en revisión');
  });

  it('maps "Resuelta" to "Resolver"', () => {
    expect(formatTransitionButtonLabel('Resuelta')).toBe('Resolver');
  });

  it('maps "Ignorada" to "Ignorar"', () => {
    expect(formatTransitionButtonLabel('Ignorada')).toBe('Ignorar');
  });
});

describe('getTransitionButtons', () => {
  it('offers all three transitions ("Marcar en revisión", "Resolver", "Ignorar") from "Pendiente"', () => {
    const buttons = getTransitionButtons('Pendiente');
    expect(buttons).toEqual([
      { label: 'Marcar en revisión', state: 'En revisión' },
      { label: 'Resolver', state: 'Resuelta' },
      { label: 'Ignorar', state: 'Ignorada' },
    ]);
  });

  it('offers only "Resolver" and "Ignorar" from "En revisión"', () => {
    const buttons = getTransitionButtons('En revisión');
    expect(buttons).toEqual([
      { label: 'Resolver', state: 'Resuelta' },
      { label: 'Ignorar', state: 'Ignorada' },
    ]);
  });

  it('offers no transitions from terminal state "Resuelta"', () => {
    expect(getTransitionButtons('Resuelta')).toEqual([]);
  });

  it('offers no transitions from terminal state "Ignorada"', () => {
    expect(getTransitionButtons('Ignorada')).toEqual([]);
  });
});

describe('SeedBasketTreeDataProvider', () => {
  let pendingSeed: Seed;
  let resolvedSeed: Seed;
  let engine: StubSeedEngine;
  let provider: SeedBasketTreeDataProvider;

  beforeEach(() => {
    pendingSeed = makeSeed({ id: 'pending-1', state: 'Pendiente' });
    resolvedSeed = makeSeed({ id: 'resolved-1', state: 'Resuelta' });
    engine = new StubSeedEngine([pendingSeed, resolvedSeed]);
    provider = new SeedBasketTreeDataProvider(engine);
  });

  describe('getChildren', () => {
    it('returns only pending seeds from the injected ISeedEngine', () => {
      const children = provider.getChildren();
      expect(children).toEqual([pendingSeed]);
    });

    it('returns an empty list when there are no pending seeds', () => {
      const emptyEngine = new StubSeedEngine([resolvedSeed]);
      const emptyProvider = new SeedBasketTreeDataProvider(emptyEngine);
      expect(emptyProvider.getChildren()).toEqual([]);
    });
  });

  describe('getTreeItem', () => {
    it('produces a TreeItem with a label derived from the description and a description showing the type', () => {
      const item = provider.getTreeItem(pendingSeed);

      expect(item.label).toBe(truncateLabel(pendingSeed.description));
      expect(item.description).toBe(pendingSeed.type);
      expect(item.command.arguments).toEqual([pendingSeed]);
    });
  });

  describe('refresh', () => {
    it('fires onDidChangeTreeData', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      provider.refresh();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
