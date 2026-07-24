import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Searcher, IFileReader, MAX_SNIPPET_LINES } from '../../../src/modules/searcher/searcher';
import { IIndexer } from '../../../src/modules/indexer/index-builder';
import { BedrockContext, IBedrockClient } from '../../../src/services/bedrock-client';
import { FileEntry, RepositoryIndex, SymbolEntry } from '../../../src/core/models';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILE_A = '/repo/src/a.ts';
const FILE_B = '/repo/src/b.ts';
const FILE_C = '/repo/src/c.ts';

function makeSymbol(overrides: Partial<SymbolEntry> = {}): SymbolEntry {
  return {
    id: 'default-id',
    name: 'fooBar',
    type: 'function',
    filePath: FILE_A,
    line: 1,
    column: 1,
    endLine: 3,
    ...overrides,
  };
}

function makeFileEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: FILE_A,
    relativePath: 'src/a.ts',
    extension: '.ts',
    lastModified: new Date(),
    symbols: [],
    imports: [],
    exports: [],
    ...overrides,
  };
}

/**
 * Fixture repository index:
 *   - a.ts defines symbol `fooBar` and imports b.ts
 *   - b.ts defines symbol `helper` and has no imports
 *   - c.ts defines no symbols and imports a.ts
 *
 * So for a.ts: relatedFiles = imports b.ts, imported-by c.ts
 *    for b.ts: relatedFiles = imported-by a.ts
 */
function makeIndex(): RepositoryIndex {
  const fooBar = makeSymbol({ id: 'a#fooBar@1', name: 'fooBar', filePath: FILE_A, line: 1 });
  const helper = makeSymbol({ id: 'b#helper@1', name: 'helper', filePath: FILE_B, line: 1, type: 'function' });

  const files = new Map<string, FileEntry>([
    [FILE_A, makeFileEntry({ path: FILE_A, relativePath: 'src/a.ts', symbols: [fooBar.id] })],
    [FILE_B, makeFileEntry({ path: FILE_B, relativePath: 'src/b.ts', symbols: [helper.id] })],
    [FILE_C, makeFileEntry({ path: FILE_C, relativePath: 'src/c.ts', symbols: [] })],
  ]);

  const symbols = new Map<string, SymbolEntry>([
    [fooBar.id, fooBar],
    [helper.id, helper],
  ]);

  const importGraph = new Map<string, string[]>([
    [FILE_A, [FILE_B]],
    [FILE_B, []],
    [FILE_C, [FILE_A]],
  ]);

  return {
    rootPath: '/repo',
    files,
    symbols,
    importGraph,
    exportGraph: new Map(),
    endpoints: [],
    lastUpdated: new Date(),
  };
}

class FakeIndexer implements Pick<IIndexer, 'getIndex'> {
  constructor(private readonly index: RepositoryIndex) {}
  getIndex(): RepositoryIndex {
    return this.index;
  }
}

class StubBedrockClient implements IBedrockClient {
  isAvailableMock = vi.fn<[], Promise<boolean>>();
  queryMock = vi.fn<[string, BedrockContext], Promise<string>>();

  async isAvailable(): Promise<boolean> {
    return this.isAvailableMock();
  }

  async query(prompt: string, context: BedrockContext): Promise<string> {
    return this.queryMock(prompt, context);
  }
}

class FakeFileReader implements IFileReader {
  constructor(private readonly filesByPath: Record<string, string[]>) {}

  readFileLines(filePath: string): string[] {
    return this.filesByPath[filePath] ?? [];
  }
}

describe('Searcher', () => {
  let index: RepositoryIndex;
  let indexer: FakeIndexer;
  let bedrockClient: StubBedrockClient;
  let fileReader: FakeFileReader;

  beforeEach(() => {
    index = makeIndex();
    indexer = new FakeIndexer(index);
    bedrockClient = new StubBedrockClient();
    fileReader = new FakeFileReader({
      [FILE_A]: Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a.ts`),
      [FILE_B]: ['function helper() {}'],
      [FILE_C]: [],
    });
  });

  describe('searchExact', () => {
    it('matches symbols by case-insensitive substring on the name', () => {
      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const results = searcher.searchExact('foobar');

      expect(results).toHaveLength(1);
      expect(results[0].symbolName).toBe('fooBar');
      expect(results[0].filePath).toBe('src/a.ts');
      expect(results[0].fullPath).toBe(FILE_A);
      expect(results[0].explanation).toContain('foobar');
    });

    it('returns an empty array when nothing matches', () => {
      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      expect(searcher.searchExact('nonexistentxyz')).toEqual([]);
    });

    it('truncates the code snippet to at most MAX_SNIPPET_LINES lines', () => {
      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const [result] = searcher.searchExact('fooBar');

      const snippetLines = result.codeSnippet.split('\n');
      expect(snippetLines.length).toBeLessThanOrEqual(MAX_SNIPPET_LINES);
      expect(snippetLines.length).toBe(MAX_SNIPPET_LINES);
      expect(snippetLines[0]).toBe('line 1 of a.ts');
    });

    it('computes relatedFiles from the import graph (imports + imported-by)', () => {
      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const [result] = searcher.searchExact('fooBar');

      expect(result.relatedFiles).toEqual(
        expect.arrayContaining([
          { path: FILE_B, relationship: 'imports' },
          { path: FILE_C, relationship: 'imported-by' },
        ]),
      );
      expect(result.relatedFiles).toHaveLength(2);
    });

    it('computes imported-by relatedFiles for a symbol with no outgoing imports', () => {
      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const [result] = searcher.searchExact('helper');

      expect(result.relatedFiles).toEqual([{ path: FILE_A, relationship: 'imported-by' }]);
    });
  });

  describe('search - semantic success path', () => {
    it('returns Bedrock-explained results for the matched candidate symbol', async () => {
      bedrockClient.isAvailableMock.mockResolvedValue(true);
      bedrockClient.queryMock.mockResolvedValue(
        JSON.stringify([
          { symbolName: 'fooBar', filePath: FILE_A, explanation: 'Suma dos valores de entrada.' },
        ]),
      );

      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const results = await searcher.search('fooBar');

      expect(results).toHaveLength(1);
      expect(results[0].symbolName).toBe('fooBar');
      expect(results[0].explanation).toBe('Suma dos valores de entrada.');
      expect(results[0].relatedFiles.length).toBeGreaterThan(0);
      expect(bedrockClient.queryMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('search - fallback to searchExact', () => {
    it('falls back to exact search when Bedrock is unavailable', async () => {
      bedrockClient.isAvailableMock.mockResolvedValue(false);

      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const results = await searcher.search('fooBar');

      expect(results).toEqual(searcher.searchExact('fooBar'));
      expect(bedrockClient.queryMock).not.toHaveBeenCalled();
    });

    it('falls back to exact search when the 5s search budget elapses', async () => {
      bedrockClient.isAvailableMock.mockResolvedValue(true);
      bedrockClient.queryMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('[]'), 50)),
      );

      // Inject a tiny search budget (5ms) so the test doesn't need to wait
      // for the real 5s timeout.
      const searcher = new Searcher(indexer, bedrockClient, fileReader, 5);
      const results = await searcher.search('fooBar');

      expect(results).toEqual(searcher.searchExact('fooBar'));
    });

    it('falls back to exact search when Bedrock returns an unparseable response', async () => {
      bedrockClient.isAvailableMock.mockResolvedValue(true);
      bedrockClient.queryMock.mockResolvedValue('not valid json at all');

      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const results = await searcher.search('fooBar');

      expect(results).toEqual(searcher.searchExact('fooBar'));
    });
  });

  describe('getSuggestions', () => {
    it('suggests indexed symbol names related to the query when no matches were found', () => {
      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const suggestions = searcher.getSuggestions('foo');

      expect(suggestions).toContain('fooBar');
    });

    it('falls back to generic suggestions when nothing in the index relates to the query', () => {
      const searcher = new Searcher(indexer, bedrockClient, fileReader);
      const suggestions = searcher.getSuggestions('zzzznomatch');

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions).not.toContain('fooBar');
    });
  });
});
