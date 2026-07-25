import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { Searcher, IFileReader, MAX_SNIPPET_LINES } from '../../src/modules/searcher/searcher';
import { IIndexer } from '../../src/modules/indexer/index-builder';
import { BedrockContext, IBedrockClient } from '../../src/services/bedrock-client';
import { FileEntry, RepositoryIndex, SymbolEntry, SymbolType } from '../../src/core/models';

// ---------------------------------------------------------------------------
// Shared fakes (mirrors tests/unit/searcher/searcher.test.ts conventions)
// ---------------------------------------------------------------------------

class FakeIndexer implements Pick<IIndexer, 'getIndex'> {
  constructor(private readonly index: RepositoryIndex) {}
  getIndex(): RepositoryIndex {
    return this.index;
  }
}

/** Bedrock client stub; unused by `searchExact` but required by the constructor. */
class UnusedBedrockClient implements IBedrockClient {
  async isAvailable(): Promise<boolean> {
    throw new Error('Not used by searchExact-based property test.');
  }
  async query(_prompt: string, _context: BedrockContext): Promise<string> {
    throw new Error('Not used by searchExact-based property test.');
  }
}

class FakeFileReader implements IFileReader {
  readFileLines(_filePath: string): string[] {
    return [];
  }
}

const filePathAt = (index: number): string => `/repo/src/file${index}.ts`;

/** All ordered pairs (i, j) with i !== j for a graph of `n` files. */
function orderedPairs(n: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        pairs.push([i, j]);
      }
    }
  }
  return pairs;
}

/** Builds `importGraph` (filePath -> [imported file paths]) from a random edge-decision array. */
function buildImportGraph(n: number, edgeDecisions: boolean[]): Map<string, string[]> {
  const importGraph = new Map<string, string[]>();
  for (let i = 0; i < n; i++) {
    importGraph.set(filePathAt(i), []);
  }
  const pairs = orderedPairs(n);
  pairs.forEach(([i, j], idx) => {
    if (edgeDecisions[idx]) {
      importGraph.get(filePathAt(i))!.push(filePathAt(j));
    }
  });
  return importGraph;
}

/**
 * Arbitrary producing { fileCount, edgeDecisions, targetIndex }: a random
 * directed graph over 2-6 file paths (via a boolean decision per ordered
 * pair) plus a random target file index within range.
 */
const importGraphScenarioArbitrary = fc.integer({ min: 2, max: 6 }).chain((fileCount) =>
  fc.record({
    fileCount: fc.constant(fileCount),
    edgeDecisions: fc.array(fc.boolean(), {
      minLength: fileCount * (fileCount - 1),
      maxLength: fileCount * (fileCount - 1),
    }),
    targetIndex: fc.integer({ min: 0, max: fileCount - 1 }),
  }),
);

function buildIndex(fileCount: number, importGraph: Map<string, string[]>, targetIndex: number, symbolName: string): RepositoryIndex {
  const targetFile = filePathAt(targetIndex);
  const symbolId = `${targetFile}#${symbolName}@1`;

  const symbol: SymbolEntry = {
    id: symbolId,
    name: symbolName,
    type: 'function',
    filePath: targetFile,
    line: 1,
    column: 1,
    endLine: 1,
  };

  const files = new Map<string, FileEntry>();
  for (let i = 0; i < fileCount; i++) {
    const path = filePathAt(i);
    files.set(path, {
      path,
      relativePath: `src/file${i}.ts`,
      extension: '.ts',
      lastModified: new Date(),
      symbols: path === targetFile ? [symbolId] : [],
      imports: [],
      exports: [],
    });
  }

  const symbols = new Map<string, SymbolEntry>([[symbolId, symbol]]);

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

describe('Searcher.computeRelatedFiles (via searchExact) property tests', () => {
  // Feature: pluvianidae-mvp, Property 8: Related files from import graph
  it('relatedFiles contains exactly the direct import/imported-by edges from the import graph', () => {
    fc.assert(
      fc.property(
        importGraphScenarioArbitrary,
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{4,12}$/),
        ({ fileCount, edgeDecisions, targetIndex }, symbolName) => {
          const importGraph = buildImportGraph(fileCount, edgeDecisions);
          const targetFile = filePathAt(targetIndex);
          const index = buildIndex(fileCount, importGraph, targetIndex, symbolName);

          const searcher = new Searcher(
            new FakeIndexer(index),
            new UnusedBedrockClient(),
            new FakeFileReader(),
          );

          const results = searcher.searchExact(symbolName);
          expect(results).toHaveLength(1);
          const { relatedFiles } = results[0];

          // Independent expected computation, derived directly from the raw
          // importGraph data structure (not by calling the module's own
          // relatedFiles logic), so this isn't a tautological check.
          const expectedImports = new Set(importGraph.get(targetFile) ?? []);
          const expectedImportedBy = new Set<string>();
          for (const [otherFile, importedFiles] of importGraph) {
            if (otherFile !== targetFile && importedFiles.includes(targetFile)) {
              expectedImportedBy.add(otherFile);
            }
          }

          const actualImports = relatedFiles.filter((r) => r.relationship === 'imports').map((r) => r.path);
          const actualImportedBy = relatedFiles
            .filter((r) => r.relationship === 'imported-by')
            .map((r) => r.path);
          const actualDependency = relatedFiles.filter((r) => r.relationship === 'dependency');

          // Exactly the expected sets: no extras, no omissions.
          expect(new Set(actualImports)).toEqual(expectedImports);
          expect(actualImports).toHaveLength(expectedImports.size);
          expect(new Set(actualImportedBy)).toEqual(expectedImportedBy);
          expect(actualImportedBy).toHaveLength(expectedImportedBy.size);

          // 'dependency' is reserved/unused per the implementation's design.
          expect(actualDependency).toHaveLength(0);

          // No extra entries beyond the two expected relationship kinds.
          expect(relatedFiles).toHaveLength(expectedImports.size + expectedImportedBy.size);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Search result completeness
// ---------------------------------------------------------------------------

/** Number of dummy lines generated per fake file — comfortably over MAX_SNIPPET_LINES so truncation is actually exercised. */
const DUMMY_FILE_LINE_COUNT = 50;

/** Up to this many distinct fake file paths are used across a single generated index. */
const MAX_FILE_INDEX = 3;

/** Minimal `IBedrockClient` stub — `searchExact` never touches Bedrock, so both methods are unused. */
class NoopBedrockClient implements IBedrockClient {
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async query(_prompt: string, _context: BedrockContext): Promise<string> {
    return '';
  }
}

/** File reader stub that returns deterministic, non-empty dummy content per file path. */
class DummyContentFileReader implements IFileReader {
  constructor(private readonly filesByPath: Record<string, string[]>) {}
  readFileLines(filePath: string): string[] {
    return this.filesByPath[filePath] ?? [];
  }
}

const symbolTypeArbitrary: fc.Arbitrary<SymbolType> = fc.constantFrom(
  'function',
  'class',
  'component',
  'variable',
  'type',
  'interface',
  'enum',
  'endpoint',
);

interface GeneratedSymbolSpec {
  name: string;
  type: SymbolType;
  fileIndex: number;
  line: number;
  column: number;
  endLine: number;
}

const symbolSpecArbitrary: fc.Arbitrary<GeneratedSymbolSpec> = fc.record({
  name: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{2,12}$/),
  type: symbolTypeArbitrary,
  fileIndex: fc.integer({ min: 0, max: MAX_FILE_INDEX }),
  line: fc.integer({ min: 1, max: 100 }),
  column: fc.integer({ min: 0, max: 50 }),
  endLine: fc.integer({ min: 1, max: 120 }),
});

// At least one symbol is required so a query can always be derived from it.
const symbolsArbitrary = fc.uniqueArray(symbolSpecArbitrary, {
  minLength: 1,
  maxLength: 10,
  selector: (spec) => spec.name,
});

function completenessFilePath(fileIndex: number): string {
  return `/repo/src/completeness-file${fileIndex}.ts`;
}

/**
 * Builds a `RepositoryIndex` from generated specs: one `FileEntry` per
 * distinct `fileIndex` referenced, and one `SymbolEntry` per spec (unique by
 * name, per `symbolsArbitrary`'s selector).
 */
function buildCompletenessIndex(specs: GeneratedSymbolSpec[]): RepositoryIndex {
  const filePaths = Array.from(new Set(specs.map((spec) => completenessFilePath(spec.fileIndex))));

  const files = new Map<string, FileEntry>();
  for (const filePath of filePaths) {
    files.set(filePath, {
      path: filePath,
      relativePath: filePath.replace('/repo/', ''),
      extension: '.ts',
      lastModified: new Date(),
      symbols: [],
      imports: [],
      exports: [],
    });
  }

  const symbols = new Map<string, SymbolEntry>();
  for (const spec of specs) {
    const filePath = completenessFilePath(spec.fileIndex);
    const symbol: SymbolEntry = {
      id: `${spec.name}#${filePath}@${spec.line}`,
      name: spec.name,
      type: spec.type,
      filePath,
      line: spec.line,
      column: spec.column,
      endLine: spec.endLine,
    };
    symbols.set(symbol.id, symbol);
  }

  return {
    rootPath: '/repo',
    files,
    symbols,
    importGraph: new Map(filePaths.map((filePath) => [filePath, []])),
    exportGraph: new Map(),
    endpoints: [],
    lastUpdated: new Date(),
  };
}

function buildCompletenessFileReader(specs: GeneratedSymbolSpec[]): DummyContentFileReader {
  const filePaths = Array.from(new Set(specs.map((spec) => completenessFilePath(spec.fileIndex))));
  const filesByPath: Record<string, string[]> = {};
  for (const filePath of filePaths) {
    filesByPath[filePath] = Array.from(
      { length: DUMMY_FILE_LINE_COUNT },
      (_, i) => `dummy line ${i + 1} of ${filePath}`,
    );
  }
  return new DummyContentFileReader(filesByPath);
}

describe('Searcher.searchExact property tests', () => {
  // Feature: pluvianidae-mvp, Property 7: Search result completeness
  // Validates: Requirements 2.2
  it('every searchExact result has a non-empty file name, full path, symbol name, an at-most-20-line snippet, and an explanation', () => {
    fc.assert(
      fc.property(
        symbolsArbitrary,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (specs, pickSeed, startSeed, lengthSeed) => {
          const index = buildCompletenessIndex(specs);
          const indexer = new FakeIndexer(index);
          const bedrockClient = new NoopBedrockClient();
          const fileReader = buildCompletenessFileReader(specs);
          const searcher = new Searcher(indexer, bedrockClient, fileReader);

          // Derive the query as a random, non-empty contiguous substring of
          // a randomly chosen generated symbol's name, guaranteeing at
          // least one match (avoids a vacuously-true property over empty
          // result sets).
          const target = specs[pickSeed % specs.length];
          const name = target.name;
          const start = startSeed % name.length;
          const maxLen = name.length - start;
          const length = (lengthSeed % maxLen) + 1;
          const query = name.slice(start, start + length);

          const results = searcher.searchExact(query);

          expect(results.length).toBeGreaterThan(0);
          for (const result of results) {
            expect(result.filePath.length).toBeGreaterThan(0);
            expect(result.fullPath.length).toBeGreaterThan(0);
            expect(result.symbolName.length).toBeGreaterThan(0);

            const snippetLines = result.codeSnippet.split('\n');
            expect(snippetLines.length).toBeLessThanOrEqual(MAX_SNIPPET_LINES);

            expect(result.explanation.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
