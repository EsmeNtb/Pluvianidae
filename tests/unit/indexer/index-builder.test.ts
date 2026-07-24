import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IndexBuilder } from '../../../src/modules/indexer/index-builder';
import { EventBus, PluvianidaeEvent } from '../../../src/core/event-bus';
import { ISymbolExtractor, SymbolExtractionResult } from '../../../src/modules/indexer/symbol-extractor';
import { IFileDiscovery } from '../../../src/modules/indexer/file-discovery';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-index-builder-'));
}

async function writeFile(root: string, relativePath: string, content = ''): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

describe('IndexBuilder', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('indexes a small multi-file fixture, populating symbols, imports, exports and endpoints', async () => {
    await writeFile(
      root,
      'src/math.ts',
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    await writeFile(
      root,
      'src/server.ts',
      `import { add } from './math';\nimport express from 'express';\nconst app = express();\napp.get('/sum', (req, res) => {\n  res.send(String(add(1, 2)));\n});\n`,
    );

    const builder = new IndexBuilder();
    const result = await builder.indexRepository(root);

    expect(result.totalFiles).toBe(2);
    expect(result.filesProcessed).toBe(2);
    expect(result.errors).toEqual([]);
    expect(typeof result.duration).toBe('number');
    expect(result.duration).toBeGreaterThanOrEqual(0);

    const index = builder.getIndex();
    expect(index.rootPath).toBe(root);
    expect(index.files.size).toBe(2);

    const symbolNames = Array.from(index.symbols.values()).map((s) => s.name);
    expect(symbolNames).toContain('add');

    const mathFile = path.join(root, 'src', 'math.ts');
    const mathEntry = index.files.get(mathFile);
    expect(mathEntry).toBeDefined();
    expect(mathEntry?.exports.map((e) => e.name)).toContain('add');

    expect(index.endpoints).toHaveLength(1);
    expect(index.endpoints[0]).toMatchObject({ route: '/sum', method: 'GET' });

    expect(index.lastUpdated).toBeInstanceOf(Date);
  });

  it('resolves relative imports to absolute local file paths in the import graph', async () => {
    await writeFile(root, 'src/utils/math.ts', `export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    await writeFile(
      root,
      'src/index.ts',
      `import { add } from './utils/math';\nimport React from 'react';\nconsole.log(add(1, 2), React);\n`,
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);
    const index = builder.getIndex();

    const indexFile = path.join(root, 'src', 'index.ts');
    const mathFile = path.join(root, 'src', 'utils', 'math.ts');

    const edges = index.importGraph.get(indexFile);
    expect(edges).toBeDefined();
    // Local relative import resolves to the math file; the bare 'react'
    // specifier is an external package and is omitted from the graph.
    expect(edges).toEqual([mathFile]);
  });

  it('skips a file that throws during extraction, records an IndexError, and continues indexing', async () => {
    await writeFile(root, 'src/good.ts', `export function ok(): void {}\n`);
    await writeFile(root, 'src/bad.ts', `this content does not matter, the extractor stub will throw\n`);

    const throwingExtractor: ISymbolExtractor = {
      extractFromSource(filePath: string, sourceText: string): SymbolExtractionResult {
        if (filePath.endsWith('bad.ts')) {
          throw new Error('simulated syntax error');
        }
        return { symbols: [], imports: [], exports: [], endpoints: [] };
      },
    };

    const builder = new IndexBuilder(undefined, throwingExtractor);
    const result = await builder.indexRepository(root);

    expect(result.totalFiles).toBe(2);
    expect(result.filesProcessed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].filePath).toBe(path.join(root, 'src', 'bad.ts'));
    expect(result.errors[0].description).toContain('simulated syntax error');

    const index = builder.getIndex();
    expect(index.files.has(path.join(root, 'src', 'good.ts'))).toBe(true);
    expect(index.files.has(path.join(root, 'src', 'bad.ts'))).toBe(false);
  });

  it('emits indexing:started, indexing:progress, and indexing:completed events in order', async () => {
    await writeFile(root, 'src/a.ts', `export const a = 1;\n`);
    await writeFile(root, 'src/b.ts', `export const b = 2;\n`);

    const eventBus = new EventBus();
    const received: PluvianidaeEvent[] = [];
    eventBus.on('indexing:started', (e) => received.push(e));
    eventBus.on('indexing:progress', (e) => received.push(e));
    eventBus.on('indexing:completed', (e) => received.push(e));

    const builder = new IndexBuilder(undefined, undefined, eventBus);
    await builder.indexRepository(root);

    expect(received[0].type).toBe('indexing:started');
    expect(received[0].payload).toEqual({ totalFiles: 2 });

    const progressEvents = received.filter((e) => e.type === 'indexing:progress');
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0].payload).toMatchObject({ current: 1, total: 2 });
    expect(progressEvents[1].payload).toMatchObject({ current: 2, total: 2 });

    const completedEvent = received[received.length - 1];
    expect(completedEvent.type).toBe('indexing:completed');
    expect(completedEvent.payload).toMatchObject({ filesIndexed: 2, errors: [] });
  });

  it('removeFile removes a file entry, its symbols and endpoints, and rebuilds the graphs', async () => {
    await writeFile(root, 'src/math.ts', `export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    await writeFile(root, 'src/index.ts', `import { add } from './math';\nconsole.log(add(1, 2));\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const mathFile = path.join(root, 'src', 'math.ts');
    const indexFile = path.join(root, 'src', 'index.ts');

    builder.removeFile(mathFile);
    const index = builder.getIndex();

    expect(index.files.has(mathFile)).toBe(false);
    expect(Array.from(index.symbols.values()).some((s) => s.filePath === mathFile)).toBe(false);
    expect(index.importGraph.get(indexFile)).toEqual([]);
  });

  it('propagates a discoverFiles failure and still calls indexing:started with zero files', async () => {
    const emptyDiscovery: IFileDiscovery = {
      async discoverFiles(): Promise<string[]> {
        return [];
      },
    };

    const eventBus = new EventBus();
    const received: PluvianidaeEvent[] = [];
    eventBus.on('indexing:started', (e) => received.push(e));
    eventBus.on('indexing:completed', (e) => received.push(e));

    const builder = new IndexBuilder(emptyDiscovery, undefined, eventBus);
    const result = await builder.indexRepository(root);

    expect(result.totalFiles).toBe(0);
    expect(result.filesProcessed).toBe(0);
    expect(received[0].payload).toEqual({ totalFiles: 0 });
    expect(received[1].payload).toMatchObject({ filesIndexed: 0, errors: [] });
  });
});
