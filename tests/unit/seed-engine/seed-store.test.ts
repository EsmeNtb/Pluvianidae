import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  SeedStore,
  ISeedFileSystem,
  ISeedPersistenceConsent,
  StaticSeedPersistenceConsent,
  FsSeedFileSystem,
  SEED_STORE_DIRNAME,
  SEED_STORE_FILENAME,
} from '../../../src/modules/seed-engine/seed-store';
import { ISeedEngine } from '../../../src/modules/seed-engine/seed-engine';
import { Seed } from '../../../src/core/models';

// ---------------------------------------------------------------------------
// Fixtures / stubs
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-seed-store-'));
}

function makeSeed(overrides: Partial<Seed> = {}): Seed {
  return {
    id: 's1',
    type: 'problema',
    sourceModule: 'dead-code-detector',
    location: { filePath: '/repo/src/index.ts', line: 10, column: 1 },
    description: 'Variable no utilizada',
    suggestedAction: 'Eliminar la variable',
    state: 'Pendiente',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

class FakeSeedEngine implements Pick<ISeedEngine, 'getAllSeeds'> {
  constructor(private readonly seeds: Seed[]) {}
  getAllSeeds(): Seed[] {
    return this.seeds;
  }
}

/** In-memory filesystem stub for tests that don't need a real temp directory. */
class StubSeedFileSystem implements ISeedFileSystem {
  files = new Map<string, string>();
  mkdirCalled = false;

  async readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file "${filePath}"`);
    }
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  async fileExists(filePath: string): Promise<boolean> {
    return this.files.has(filePath);
  }

  async mkdir(_dirPath: string): Promise<void> {
    this.mkdirCalled = true;
  }
}

const TARGET_RELATIVE_PATH = path.join(SEED_STORE_DIRNAME, SEED_STORE_FILENAME);

// ---------------------------------------------------------------------------
// save()
// ---------------------------------------------------------------------------

describe('SeedStore.save', () => {
  it('does nothing when consent is not granted (no file written)', async () => {
    const fileSystem = new StubSeedFileSystem();
    const store = new SeedStore(
      '/workspace',
      new FakeSeedEngine([makeSeed()]),
      fileSystem,
      new StaticSeedPersistenceConsent(false),
    );

    await store.save();

    expect(fileSystem.files.size).toBe(0);
    expect(fileSystem.mkdirCalled).toBe(false);
  });

  it('writes seeds to disk when consent is granted', async () => {
    const fileSystem = new StubSeedFileSystem();
    const seed = makeSeed();
    const store = new SeedStore('/workspace', new FakeSeedEngine([seed]), fileSystem, new StaticSeedPersistenceConsent(true));

    await store.save();

    expect(fileSystem.mkdirCalled).toBe(true);
    const targetPath = path.join('/workspace', TARGET_RELATIVE_PATH);
    expect(fileSystem.files.has(targetPath)).toBe(true);
    const parsed = JSON.parse(fileSystem.files.get(targetPath)!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(seed.id);
    expect(parsed[0].description).toBe(seed.description);
  });

  it('checks consent on every call (fresh, not cached)', async () => {
    const fileSystem = new StubSeedFileSystem();
    let granted = false;
    const dynamicConsent: ISeedPersistenceConsent = {
      isGranted: async () => granted,
    };
    const store = new SeedStore('/workspace', new FakeSeedEngine([makeSeed()]), fileSystem, dynamicConsent);

    await store.save();
    expect(fileSystem.files.size).toBe(0);

    granted = true;
    await store.save();
    expect(fileSystem.files.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

describe('SeedStore.load', () => {
  it('populates seeds from a previously saved file, reviving Date fields (round-trip)', async () => {
    const fileSystem = new StubSeedFileSystem();
    const seed = makeSeed();
    const saveStore = new SeedStore(
      '/workspace',
      new FakeSeedEngine([seed]),
      fileSystem,
      new StaticSeedPersistenceConsent(true),
    );
    await saveStore.save();

    const loadStore = new SeedStore('/workspace', new FakeSeedEngine([]), fileSystem);
    await loadStore.load();

    expect(loadStore.seeds.size).toBe(1);
    const loaded = loadStore.seeds.get(seed.id);
    expect(loaded).toBeDefined();
    expect(loaded!.createdAt).toBeInstanceOf(Date);
    expect(loaded!.updatedAt).toBeInstanceOf(Date);
    expect(loaded!.createdAt.getTime()).toBe(seed.createdAt.getTime());
    expect(loaded!.description).toBe(seed.description);
  });

  it('leaves seeds empty when no file exists', async () => {
    const fileSystem = new StubSeedFileSystem();
    const store = new SeedStore('/workspace', new FakeSeedEngine([]), fileSystem);

    await store.load();

    expect(store.seeds.size).toBe(0);
  });

  it('handles a corrupted/malformed JSON file gracefully without throwing', async () => {
    const fileSystem = new StubSeedFileSystem();
    const targetPath = path.join('/workspace', TARGET_RELATIVE_PATH);
    fileSystem.files.set(targetPath, '{ this is not valid JSON ');
    const store = new SeedStore('/workspace', new FakeSeedEngine([]), fileSystem);

    await expect(store.load()).resolves.not.toThrow();
    expect(store.seeds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Real filesystem integration test
// ---------------------------------------------------------------------------

describe('SeedStore with FsSeedFileSystem (real filesystem)', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  it('round-trips seeds through the real filesystem in a temp directory', async () => {
    const seed = makeSeed({ id: 's-real', description: 'Endpoint sin consumir' });
    const saveStore = new SeedStore(root, new FakeSeedEngine([seed]), new FsSeedFileSystem(), new StaticSeedPersistenceConsent(true));

    await saveStore.save();

    const writtenPath = path.join(root, SEED_STORE_DIRNAME, SEED_STORE_FILENAME);
    const exists = await fs
      .access(writtenPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const loadStore = new SeedStore(root, new FakeSeedEngine([]), new FsSeedFileSystem());
    await loadStore.load();

    expect(loadStore.seeds.size).toBe(1);
    const loaded = loadStore.seeds.get('s-real');
    expect(loaded?.description).toBe('Endpoint sin consumir');
    expect(loaded?.createdAt).toBeInstanceOf(Date);
  });

  it('does not write anything to the real filesystem when consent is denied', async () => {
    const store = new SeedStore(root, new FakeSeedEngine([makeSeed()]), new FsSeedFileSystem(), new StaticSeedPersistenceConsent(false));

    await store.save();

    const dirExists = await fs
      .access(path.join(root, SEED_STORE_DIRNAME))
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(false);
  });
});
