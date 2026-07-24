/**
 * Repository Index builder for the Indexador module.
 *
 * Orchestrates `FileDiscovery` (task 2.1) and `SymbolExtractor` (task 2.2)
 * to build a complete `RepositoryIndex`: it discovers indexable files, reads
 * and parses each one, collects the resulting symbols/imports/exports/
 * endpoints, resolves the import graph to local file paths, builds the
 * export graph, and emits Event Bus progress events throughout.
 *
 * See design.md > "3. Indexador (`modules/indexer/`)" and requirements.md >
 * Requirement 1 (1.2, 1.5, 1.6).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  EndpointEntry,
  ExportedSymbol,
  FileEntry,
  IndexError,
  RepositoryIndex,
  SymbolEntry,
} from '../../core/models';
import { EventBus, IEventBus } from '../../core/event-bus';
import { FileDiscovery, IFileDiscovery } from './file-discovery';
import { ISymbolExtractor, SymbolExtractor } from './symbol-extractor';

export interface IndexResult {
  filesProcessed: number;
  totalFiles: number;
  errors: IndexError[];
  duration: number;
}

export interface IIndexer {
  indexRepository(rootPath: string): Promise<IndexResult>;
  updateFile(filePath: string): Promise<void>;
  removeFile(filePath: string): void;
  getIndex(): RepositoryIndex;
}

/** Extensions tried, in order, when resolving a relative import specifier without an extension. */
const RESOLVABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx'];

/** Creates an empty `RepositoryIndex` rooted at `rootPath`. */
function createEmptyIndex(rootPath: string): RepositoryIndex {
  return {
    rootPath,
    files: new Map(),
    symbols: new Map(),
    importGraph: new Map(),
    exportGraph: new Map(),
    endpoints: [],
    lastUpdated: new Date(),
  };
}

/**
 * Builds and maintains a `RepositoryIndex` by coordinating file discovery
 * and per-file symbol extraction.
 *
 * Design notes / simplifications for the MVP:
 *   - Files are processed sequentially rather than in parallel. This keeps
 *     `indexing:progress` events strictly ordered and avoids unbounded
 *     concurrent file-system/CPU load on large repositories; it can be
 *     revisited (e.g. bounded parallelism) if indexing throughput becomes a
 *     concern.
 *   - `ts.createSourceFile` (used by `SymbolExtractor`) does not throw on
 *     most malformed syntax — it produces a best-effort AST with error
 *     nodes instead of raising an exception. Implementing full
 *     diagnostic-based syntax validation (e.g. via `ts.createProgram` and
 *     inspecting `getSyntacticDiagnostics()`) is out of scope for the MVP.
 *     Instead, syntax-error resilience (Requirement 1.6) is satisfied
 *     pragmatically: reading the file and extracting symbols from it is
 *     wrapped in a try/catch, and any thrown error (unreadable file,
 *     extractor exception, etc.) is captured as an `IndexError`, logged,
 *     and the file is skipped while indexing continues with the rest. This
 *     covers the exception-raising failure modes; if deeper syntax
 *     diagnostics are desired later, they can be layered into
 *     `processFile` without changing this class's public surface.
 */
export class IndexBuilder implements IIndexer {
  private readonly fileDiscovery: IFileDiscovery;
  private readonly symbolExtractor: ISymbolExtractor;
  private readonly eventBus: IEventBus;
  private index: RepositoryIndex;

  constructor(
    fileDiscovery: IFileDiscovery = new FileDiscovery(),
    symbolExtractor: ISymbolExtractor = new SymbolExtractor(),
    eventBus: IEventBus = new EventBus(),
  ) {
    this.fileDiscovery = fileDiscovery;
    this.symbolExtractor = symbolExtractor;
    this.eventBus = eventBus;
    this.index = createEmptyIndex('');
  }

  async indexRepository(rootPath: string): Promise<IndexResult> {
    const startTime = Date.now();
    const files = await this.fileDiscovery.discoverFiles(rootPath);
    const totalFiles = files.length;

    this.eventBus.emit({ type: 'indexing:started', payload: { totalFiles } });

    const index = createEmptyIndex(rootPath);
    const errors: IndexError[] = [];
    let filesProcessed = 0;

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const outcome = await this.processFile(rootPath, filePath, index);
      if (outcome.error) {
        errors.push(outcome.error);
      } else {
        filesProcessed++;
      }

      this.eventBus.emit({
        type: 'indexing:progress',
        payload: { current: i + 1, total: totalFiles, currentFile: filePath },
      });
    }

    index.importGraph = buildImportGraph(index.files);
    index.exportGraph = buildExportGraph(index.files);
    index.lastUpdated = new Date();

    this.index = index;

    this.eventBus.emit({
      type: 'indexing:completed',
      payload: { filesIndexed: filesProcessed, errors },
    });

    return {
      filesProcessed,
      totalFiles,
      errors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Re-indexes a single file and merges the result into the current index.
   *
   * This is a straightforward re-extract-and-replace implementation
   * sufficient to support task 2.4's incremental indexing on top of it: it
   * removes any previous entries for `filePath` (symbols, endpoints) before
   * re-processing it, then rebuilds the import/export graphs so they stay
   * consistent. File-watcher wiring and debouncing/timeout behavior belong
   * to task 2.4, not here.
   */
  async updateFile(filePath: string): Promise<void> {
    this.removeFile(filePath);
    await this.processFile(this.index.rootPath, filePath, this.index);
    this.index.importGraph = buildImportGraph(this.index.files);
    this.index.exportGraph = buildExportGraph(this.index.files);
    this.index.lastUpdated = new Date();
  }

  /**
   * Removes a file's entries (file, symbols, endpoints) from the index and
   * rebuilds the import/export graphs. Does not throw if `filePath` is not
   * currently indexed.
   */
  removeFile(filePath: string): void {
    const fileEntry = this.index.files.get(filePath);
    if (fileEntry) {
      for (const symbolId of fileEntry.symbols) {
        this.index.symbols.delete(symbolId);
      }
      this.index.files.delete(filePath);
    }

    this.index.endpoints = this.index.endpoints.filter((endpoint) => endpoint.filePath !== filePath);
    this.index.importGraph = buildImportGraph(this.index.files);
    this.index.exportGraph = buildExportGraph(this.index.files);
    this.index.lastUpdated = new Date();
  }

  getIndex(): RepositoryIndex {
    return this.index;
  }

  /**
   * Reads and extracts symbols from a single file, adding the results to
   * `index` on success or returning an `IndexError` on failure. Never
   * throws — all failures (unreadable file, stat failure, extractor
   * exception) are captured and reported via the returned outcome.
   */
  private async processFile(
    rootPath: string,
    filePath: string,
    index: RepositoryIndex,
  ): Promise<{ error?: IndexError }> {
    try {
      const [contents, stat] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
      const extraction = this.symbolExtractor.extractFromSource(filePath, contents);

      const fileEntry: FileEntry = {
        path: filePath,
        relativePath: toPosixRelativePath(rootPath, filePath),
        extension: path.extname(filePath),
        lastModified: stat.mtime,
        symbols: extraction.symbols.map((symbol) => symbol.id),
        imports: extraction.imports,
        exports: extraction.exports,
      };

      index.files.set(filePath, fileEntry);
      for (const symbol of extraction.symbols) {
        index.symbols.set(symbol.id, symbol);
      }
      index.endpoints.push(...extraction.endpoints);

      return {};
    } catch (err) {
      const description = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[Pluvianidae] Indexing error in ${filePath}: ${description}`);
      return { error: { filePath, description } };
    }
  }
}

// ---------------------------------------------------------------------------
// Import / export graph construction
// ---------------------------------------------------------------------------

/**
 * Attempts to resolve a relative import specifier (e.g. `./foo`,
 * `../bar/baz`) to an absolute file path present in `knownFiles`, trying
 * each of `RESOLVABLE_EXTENSIONS` directly and then as `index.*` within a
 * directory of that name. Returns `undefined` if no candidate matches a
 * known file (including for bare/external module specifiers, which are not
 * attempted at all since they don't start with `.`).
 *
 * Exported (rather than kept module-private) so that
 * `reference-analyzer.ts` can reuse the exact same resolution logic when
 * computing which files import a given symbol's defining file, instead of
 * duplicating/diverging import-path resolution behavior.
 */
export function resolveImportPath(
  importingFile: string,
  source: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  if (!source.startsWith('.')) {
    // Bare module specifier (e.g. 'react', 'express') — external package,
    // not part of the local file graph.
    return undefined;
  }

  const baseDir = path.dirname(importingFile);
  const resolvedBase = path.resolve(baseDir, source);

  // Already has a resolvable extension and exists as-is.
  if (knownFiles.has(resolvedBase)) {
    return resolvedBase;
  }

  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = resolvedBase + ext;
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }

  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = path.join(resolvedBase, `index${ext}`);
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function buildImportGraph(files: ReadonlyMap<string, FileEntry>): Map<string, string[]> {
  const knownFiles = new Set(files.keys());
  const graph = new Map<string, string[]>();

  for (const [filePath, fileEntry] of files) {
    const resolved: string[] = [];
    for (const importEntry of fileEntry.imports) {
      const target = resolveImportPath(filePath, importEntry.source, knownFiles);
      if (target) {
        resolved.push(target);
      }
    }
    graph.set(filePath, resolved);
  }

  return graph;
}

function buildExportGraph(files: ReadonlyMap<string, FileEntry>): Map<string, ExportedSymbol[]> {
  const graph = new Map<string, ExportedSymbol[]>();

  for (const [filePath, fileEntry] of files) {
    const exported: ExportedSymbol[] = fileEntry.exports.map((exportEntry) => ({
      name: exportEntry.name,
      filePath,
      isDefault: exportEntry.isDefault,
    }));
    graph.set(filePath, exported);
  }

  return graph;
}

function toPosixRelativePath(rootPath: string, fullPath: string): string {
  return path.relative(rootPath, fullPath).split(path.sep).join('/');
}

// Re-export for callers that only need endpoint aggregation type info.
export type { EndpointEntry, SymbolEntry };
