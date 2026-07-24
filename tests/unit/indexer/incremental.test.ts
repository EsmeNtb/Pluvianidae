import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IncrementalIndexer } from '../../../src/modules/indexer/incremental';
import { IndexBuilder, IIndexer, IndexResult } from '../../../src/modules/indexer/index-builder';
import { EventBus, PluvianidaeEvent } from '../../../src/core/event-bus';
import { RepositoryIndex } from '../../../src/core/models';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-incremental-'));
}

async function writeFile(root: string, relativePath: string, content = ''): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

describe('IncrementalIndexer', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('create triggers updateFile and adds the new file to the index', async () => {
    await writeFile(root, 'src/existing.ts', `export const existing = 1;\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const incremental = new IncrementalIndexer(builder);

    const newFile = path.join(root, 'src', 'newFile.ts');
    await writeFile(root, 'src/newFile.ts', `export function added(): number {\n  return 42;\n}\n`);

    await incremental.handleFileChange(newFile, 'create');

    const index = builder.getIndex();
    expect(index.files.has(newFile)).toBe(true);
    const symbolNames = Array.from(index.symbols.values()).map((s) => s.name);
    expect(symbolNames).toContain('added');
  });

  it('modify triggers updateFile and reflects the new content in the index', async () => {
    await writeFile(root, 'src/math.ts', `export function add(a: number, b: number): number {\n  return a + b;\n}\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const incremental = new IncrementalIndexer(builder);
    const mathFile = path.join(root, 'src', 'math.ts');

    await writeFile(
      root,
      'src/math.ts',
      `export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n`,
    );

    await incremental.handleFileChange(mathFile, 'modify');

    const index = builder.getIndex();
    const mathEntry = index.files.get(mathFile);
    expect(mathEntry?.exports.map((e) => e.name)).toEqual(['add', 'subtract']);
  });

  it('delete triggers removeFile and removes the file, its symbols and endpoints from the index', async () => {
    await writeFile(root, 'src/math.ts', `export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    await writeFile(root, 'src/index.ts', `import { add } from './math';\nconsole.log(add(1, 2));\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const incremental = new IncrementalIndexer(builder);
    const mathFile = path.join(root, 'src', 'math.ts');
    const indexFile = path.join(root, 'src', 'index.ts');

    await fs.rm(mathFile);
    await incremental.handleFileChange(mathFile, 'delete');

    const index = builder.getIndex();
    expect(index.files.has(mathFile)).toBe(false);
    expect(Array.from(index.symbols.values()).some((s) => s.filePath === mathFile)).toBe(false);
    expect(index.importGraph.get(indexFile)).toEqual([]);
  });

  it('does not process changes for excluded files (dependency directories, gitignore, security filter)', async () => {
    await writeFile(root, 'src/main.ts', `export const main = 1;\n`);
    await writeFile(root, '.gitignore', 'ignored/\n');
    await writeFile(root, 'ignored/file.ts', `export const shouldBeIgnored = 1;\n`);
    await writeFile(root, 'node_modules/pkg/index.ts', `export const dep = 1;\n`);
    await writeFile(root, 'src/.env.ts', `export const secret = 1;\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const incremental = new IncrementalIndexer(builder);

    const gitignoredFile = path.join(root, 'ignored', 'file.ts');
    const nodeModulesFile = path.join(root, 'node_modules', 'pkg', 'index.ts');
    const securityFilteredFile = path.join(root, 'src', '.env.ts');

    await incremental.handleFileChange(gitignoredFile, 'create');
    await incremental.handleFileChange(nodeModulesFile, 'create');
    await incremental.handleFileChange(securityFilteredFile, 'create');

    const index = builder.getIndex();
    expect(index.files.has(gitignoredFile)).toBe(false);
    expect(index.files.has(nodeModulesFile)).toBe(false);
    expect(index.files.has(securityFilteredFile)).toBe(false);
  });

  it('ignores changes to non-indexable file extensions', async () => {
    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const incremental = new IncrementalIndexer(builder);
    const updateFileSpy = vi.spyOn(builder, 'updateFile');

    const txtFile = path.join(root, 'notes.txt');
    await incremental.handleFileChange(txtFile, 'create');

    expect(updateFileSpy).not.toHaveBeenCalled();
  });

  it('completes the update even when it exceeds the soft timeout, logging a warning but not aborting', async () => {
    const emptyIndex: RepositoryIndex = {
      rootPath: root,
      files: new Map(),
      symbols: new Map(),
      importGraph: new Map(),
      exportGraph: new Map(),
      endpoints: [],
      lastUpdated: new Date(),
    };

    let updateFileCompleted = false;
    const slowIndexer: IIndexer = {
      async indexRepository(): Promise<IndexResult> {
        return { filesProcessed: 0, totalFiles: 0, errors: [], duration: 0 };
      },
      async updateFile(): Promise<void> {
        // Simulate slowness without an actual 5s+ real-time wait.
        await new Promise((resolve) => setTimeout(resolve, 10));
        updateFileCompleted = true;
      },
      removeFile(): void {
        // no-op for this test
      },
      getIndex(): RepositoryIndex {
        return emptyIndex;
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Use a very small soft timeout (1ms) so the 10ms simulated update
    // reliably exceeds it, without needing to wait for the real 5s budget.
    const incremental = new IncrementalIndexer(slowIndexer, undefined, undefined, 1);

    const slowFile = path.join(root, 'src', 'slow.ts');
    await incremental.handleFileChange(slowFile, 'create');

    expect(updateFileCompleted).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('exceeding the 1ms target');

    warnSpy.mockRestore();
  });

  it('emits indexing:started, indexing:progress and indexing:completed for a single-file update', async () => {
    await writeFile(root, 'src/a.ts', `export const a = 1;\n`);
    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const eventBus = new EventBus();
    const received: PluvianidaeEvent[] = [];
    eventBus.on('indexing:started', (e) => received.push(e));
    eventBus.on('indexing:progress', (e) => received.push(e));
    eventBus.on('indexing:completed', (e) => received.push(e));

    const incremental = new IncrementalIndexer(builder, undefined, eventBus);
    const aFile = path.join(root, 'src', 'a.ts');
    await writeFile(root, 'src/a.ts', `export const a = 2;\n`);

    await incremental.handleFileChange(aFile, 'modify');

    expect(received.map((e) => e.type)).toEqual(['indexing:started', 'indexing:progress', 'indexing:completed']);
    expect(received[0].payload).toEqual({ totalFiles: 1 });
    expect(received[2].payload).toMatchObject({ filesIndexed: 1, errors: [] });
  });

  it('handles errors during update by logging an IndexError and not throwing', async () => {
    await writeFile(root, 'src/a.ts', `export const a = 1;\n`);
    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const failingIndexer: IIndexer = {
      indexRepository: builder.indexRepository.bind(builder),
      updateFile: async () => {
        throw new Error('simulated failure');
      },
      removeFile: builder.removeFile.bind(builder),
      getIndex: builder.getIndex.bind(builder),
    };

    const eventBus = new EventBus();
    const received: PluvianidaeEvent[] = [];
    eventBus.on('indexing:completed', (e) => received.push(e));

    const incremental = new IncrementalIndexer(failingIndexer, undefined, eventBus);
    const aFile = path.join(root, 'src', 'a.ts');

    await expect(incremental.handleFileChange(aFile, 'modify')).resolves.toBeUndefined();

    expect(received).toHaveLength(1);
    expect(received[0].payload).toMatchObject({
      filesIndexed: 0,
      errors: [{ filePath: aFile, description: 'simulated failure' }],
    });
  });
});
