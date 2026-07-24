/**
 * Analizador de Referencias (Reference Analyzer) module.
 *
 * Builds a `ReferenceMap` for a given symbol: where it's defined, which
 * files import it, where it's used, which functions it calls directly
 * (first level only), and which files depend on it. See design.md >
 * "5. Analizador de Referencias (`modules/reference-analyzer/`)" and
 * requirements.md > Requirement 3 (3.1-3.6).
 *
 * Design deviations / interpretation decisions (documented here since
 * design.md leaves some shapes ambiguous, rather than being arbitrary
 * changes):
 *
 *   1. **`SymbolIdentifier`** — design.md's `IReferenceAnalyzer.getReferences`
 *      takes a `SymbolIdentifier` but never defines that type. We define it
 *      as a union: `{ symbolId: string }` (unambiguous direct lookup by the
 *      `SymbolEntry.id` the caller already has, e.g. from a prior Buscador
 *      result) or `{ name: string; filePath?: string; line?: number }`
 *      (lookup by name, optionally disambiguated by file/line when several
 *      symbols share a name). When looking up by name alone and multiple
 *      symbols match, we deterministically pick the first match encountered
 *      when iterating `index.symbols` — callers that need a specific one
 *      among several same-named symbols should pass `filePath`/`line` (or,
 *      better, `symbolId`) to disambiguate.
 *
 *   2. **`dependents` vs `imports`** — design.md's `ReferenceMap` has both
 *      an `imports: SymbolLocation[]` field and a `dependents: string[]`
 *      field, but never disambiguates them beyond what's inferable from
 *      their types/names. For the MVP, `dependents` is treated as the
 *      file-level projection of `imports`: the deduplicated set of file
 *      paths that appear in `imports` (i.e., files that import *this
 *      specific symbol*, not just any symbol from its defining file). This
 *      satisfies requirements.md 3.5 ("archivos que dependen del símbolo
 *      seleccionado") while keeping `imports` as the more detailed,
 *      per-import-statement view requirements.md 3.2 asks for.
 *
 *   3. **`usages` (3.3) — textual heuristic** — full type-aware reference
 *      resolution (à la a language server) is out of scope for the MVP.
 *      Instead, we scan every indexed file's text for whole-word matches of
 *      the symbol's identifier name (using a `\b`-bounded regex) and record
 *      each match as a `SymbolUsage`, with the matched line itself as the
 *      `context` snippet — excluding (a) the exact definition line in the
 *      defining file (already surfaced via `definition`) and (b) any line
 *      that is itself an import statement pulling in this symbol (already
 *      surfaced via `imports`), so a symbol's import declaration isn't
 *      double-reported as both an import and a usage. This is a pragmatic
 *      MVP simplification: it can produce
 *      false positives for common names shared by unrelated symbols (e.g.
 *      two different `handler` functions in different files) and won't
 *      perfectly track renamed/aliased imports (`import { foo as bar }`
 *      matches would appear under the alias, not the original name). This
 *      tradeoff is acceptable given the project's scope; a follow-up could
 *      layer in real scope/type-aware resolution.
 *
 *   4. **`calls` (3.4) — first-level only** — for a function/method symbol,
 *      we re-parse its defining file and walk only the AST region between
 *      the symbol's `line` and `endLine`, collecting the callee identifier
 *      of every `ts.isCallExpression` found directly within that region (at
 *      any AST depth *inside* the function's own body), without recursing
 *      into the bodies of functions it calls. This matches requirements.md
 *      3.4's "primer nivel de profundidad" (first level of depth) literally:
 *      we record what the symbol calls, not what those calls in turn call.
 *      Calls are resolved to a `SymbolLocation` when the callee identifier
 *      matches a known symbol in the index (preferring one in the same
 *      file, then any indexed symbol with that name); unresolved callees
 *      (e.g. calls to external/library functions) are omitted from `calls`
 *      rather than guessed at.
 */

import * as fs from 'fs';
import * as ts from 'typescript';
import {
  RepositoryIndex,
  SymbolEntry,
  SymbolLocation,
  SymbolUsage,
} from '../../core/models';
import { IIndexer, resolveImportPath } from '../indexer/index-builder';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Identifies a symbol to look up references for. See class-level doc
 * comment #1 for the rationale behind this shape.
 */
export type SymbolIdentifier =
  | { symbolId: string }
  | { name: string; filePath?: string; line?: number };

export interface ReferenceMap {
  definition: SymbolLocation;
  imports: SymbolLocation[];
  usages: SymbolUsage[];
  /** funciones invocadas directamente (primer nivel de profundidad) */
  calls: SymbolLocation[];
  /** archivos que dependen del símbolo */
  dependents: string[];
}

export interface IReferenceAnalyzer {
  getReferences(symbol: SymbolIdentifier): Promise<ReferenceMap>;
}

/**
 * Thrown when the requested symbol can't be found in the repository index
 * (requirements.md 3.6). Carries a message listing possible causes so the
 * caller can surface it directly to the user, following the house error
 * style used by `BedrockTransmissionCancelledError` /
 * `BedrockTimeoutError` / `BedrockQueryError` in `services/bedrock-client.ts`.
 */
export class SymbolNotFoundError extends Error {
  constructor(descriptor: string) {
    super(
      `No se encontró el símbolo "${descriptor}" en el índice del repositorio. ` +
        'Posibles causas: el archivo que lo contiene no ha sido indexado, o el símbolo ' +
        'es externo (pertenece a una dependencia/paquete de terceros).',
    );
    this.name = 'SymbolNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Injectable abstraction over reading a source file's full text, so
 * `ReferenceAnalyzer` can be unit tested without touching the real file
 * system (mirrors `Searcher`'s `IFileReader` pattern).
 */
export interface ISourceReader {
  readFile(filePath: string): string;
}

/** Default `ISourceReader` backed by `fs.readFileSync`. */
export class FsSourceReader implements ISourceReader {
  readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }
}

export class ReferenceAnalyzer implements IReferenceAnalyzer {
  constructor(
    private readonly indexSource: Pick<IIndexer, 'getIndex'>,
    private readonly sourceReader: ISourceReader = new FsSourceReader(),
  ) {}

  async getReferences(symbolIdentifier: SymbolIdentifier): Promise<ReferenceMap> {
    const index = this.indexSource.getIndex();
    const symbol = this.resolveSymbol(index, symbolIdentifier);

    const definition: SymbolLocation = {
      filePath: symbol.filePath,
      line: symbol.line,
      column: symbol.column,
    };

    const imports = this.computeImports(index, symbol);
    const dependents = this.computeDependents(imports);
    const usages = this.computeUsages(index, symbol, imports);
    const calls = this.computeCalls(index, symbol);

    return { definition, imports, usages, calls, dependents };
  }

  // -------------------------------------------------------------------
  // Symbol resolution (3.1, 3.6)
  // -------------------------------------------------------------------

  private resolveSymbol(index: RepositoryIndex, identifier: SymbolIdentifier): SymbolEntry {
    if ('symbolId' in identifier) {
      const symbol = index.symbols.get(identifier.symbolId);
      if (!symbol) {
        throw new SymbolNotFoundError(identifier.symbolId);
      }
      return symbol;
    }

    const { name, filePath, line } = identifier;
    for (const symbol of index.symbols.values()) {
      if (symbol.name !== name) {
        continue;
      }
      if (filePath !== undefined && symbol.filePath !== filePath) {
        continue;
      }
      if (line !== undefined && symbol.line !== line) {
        continue;
      }
      return symbol;
    }

    throw new SymbolNotFoundError(name);
  }

  // -------------------------------------------------------------------
  // Imports / dependents (3.2, 3.5)
  // -------------------------------------------------------------------

  /**
   * Files that import `symbol` specifically: scans every indexed file's
   * `ImportEntry[]` for entries whose `source` resolves (via the same
   * relative-import resolution logic `index-builder.ts` uses) to the
   * symbol's defining file, and whose `specifiers` include the symbol's
   * name — or, for a default export, any default import from that file.
   */
  private computeImports(index: RepositoryIndex, symbol: SymbolEntry): SymbolLocation[] {
    const knownFiles = new Set(index.files.keys());
    const definingFileExports = index.exportGraph.get(symbol.filePath) ?? [];
    const isDefaultExport = definingFileExports.some((e) => e.name === symbol.name && e.isDefault);

    const imports: SymbolLocation[] = [];
    for (const [filePath, fileEntry] of index.files) {
      if (filePath === symbol.filePath) {
        continue;
      }
      for (const importEntry of fileEntry.imports) {
        const resolved = resolveImportPath(filePath, importEntry.source, knownFiles);
        if (resolved !== symbol.filePath) {
          continue;
        }
        const matchesNamed = importEntry.specifiers.includes(symbol.name);
        const matchesDefault = importEntry.isDefault && isDefaultExport;
        if (matchesNamed || matchesDefault) {
          imports.push({ filePath, line: importEntry.line, column: 1 });
        }
      }
    }
    return imports;
  }

  /**
   * Requirements.md 3.5: files that depend on the symbol. For the MVP this
   * is the deduplicated set of file paths from `imports` (see class-level
   * doc comment #2).
   */
  private computeDependents(imports: SymbolLocation[]): string[] {
    return [...new Set(imports.map((imp) => imp.filePath))];
  }

  // -------------------------------------------------------------------
  // Usages (3.3)
  // -------------------------------------------------------------------

  private computeUsages(
    index: RepositoryIndex,
    symbol: SymbolEntry,
    imports: SymbolLocation[],
  ): SymbolUsage[] {
    const wordBoundaryPattern = new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`, 'g');
    const usages: SymbolUsage[] = [];
    const importLines = new Set(imports.map((imp) => `${imp.filePath}:${imp.line}`));

    for (const filePath of index.files.keys()) {
      let text: string;
      try {
        text = this.sourceReader.readFile(filePath);
      } catch {
        continue;
      }

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        const lineText = lines[i];

        if (filePath === symbol.filePath && lineNumber === symbol.line) {
          // Skip the definition line itself — already surfaced via `definition`.
          continue;
        }
        if (importLines.has(`${filePath}:${lineNumber}`)) {
          // Skip import declaration lines for this symbol — already
          // surfaced via `imports` (see class-level doc comment #3).
          continue;
        }

        let match: RegExpExecArray | null;
        wordBoundaryPattern.lastIndex = 0;
        while ((match = wordBoundaryPattern.exec(lineText)) !== null) {
          usages.push({
            filePath,
            line: lineNumber,
            column: match.index + 1,
            context: lineText.trim(),
          });
        }
      }
    }

    return usages;
  }

  // -------------------------------------------------------------------
  // Calls (3.4) — first-level only
  // -------------------------------------------------------------------

  private computeCalls(index: RepositoryIndex, symbol: SymbolEntry): SymbolLocation[] {
    let sourceText: string;
    try {
      sourceText = this.sourceReader.readFile(symbol.filePath);
    } catch {
      return [];
    }

    const sourceFile = ts.createSourceFile(
      symbol.filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      getScriptKind(symbol.filePath),
    );

    const bodyNode = findSymbolBodyNode(sourceFile, symbol);
    if (!bodyNode) {
      return [];
    }

    const calleeNames = new Set<string>();
    collectDirectCallNames(bodyNode, calleeNames);

    const calls: SymbolLocation[] = [];
    for (const calleeName of calleeNames) {
      const resolved = findCalleeSymbol(index, symbol.filePath, calleeName);
      if (resolved) {
        calls.push({ filePath: resolved.filePath, line: resolved.line, column: resolved.column });
      }
    }
    return calls;
  }
}

// ---------------------------------------------------------------------------
// AST helpers for `calls` extraction (mirrors patterns from symbol-extractor.ts)
// ---------------------------------------------------------------------------

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith('.ts')) {
    return ts.ScriptKind.TS;
  }
  if (filePath.endsWith('.jsx') || filePath.endsWith('.js')) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.Unknown;
}

/**
 * Locates the AST node for `symbol`'s body by finding a function-like
 * declaration/expression/method whose start line matches `symbol.line`.
 * Returns the node whose direct (non-nested-function) descendants should be
 * scanned for call expressions.
 */
function findSymbolBodyNode(sourceFile: ts.SourceFile, symbol: SymbolEntry): ts.Node | undefined {
  let found: ts.Node | undefined;

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }

    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node);

    if (isFunctionLike) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const declaredLine = line + 1;
      // Arrow/function expressions are named via their enclosing variable
      // declaration, whose start line matches the declaration, not the
      // expression itself — so also check the parent (VariableDeclaration).
      const parentLine = ts.isVariableDeclaration(node.parent)
        ? sourceFile.getLineAndCharacterOfPosition(node.parent.getStart(sourceFile)).line + 1
        : undefined;

      if (declaredLine === symbol.line || parentLine === symbol.line) {
        found = node;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Collects the callee identifier name of every call expression found
 * within `node`, without recursing into the body of any nested function-like
 * node (so transitively-called functions' own calls are not included) —
 * this enforces the "first level of depth only" requirement (3.4).
 */
function collectDirectCallNames(node: ts.Node, out: Set<string>): void {
  const visit = (current: ts.Node, isRoot: boolean): void => {
    if (!isRoot) {
      const isNestedFunction =
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isArrowFunction(current) ||
        ts.isFunctionExpression(current);
      if (isNestedFunction) {
        // Don't descend into nested function bodies — calls made inside
        // them are second-level (transitive), not first-level.
        return;
      }
    }

    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      let name: string | undefined;
      if (ts.isIdentifier(callee)) {
        name = callee.text;
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        name = callee.name.text;
      }
      if (name) {
        out.add(name);
      }
    }

    ts.forEachChild(current, (child) => visit(child, false));
  };

  visit(node, true);
}

/**
 * Resolves a callee identifier name to a known `SymbolEntry`, preferring a
 * match within `callerFilePath` (a local helper/sibling function) and
 * falling back to any indexed symbol with that name (e.g. an imported
 * function). Returns `undefined` for unresolved callees (external/library
 * calls), which are intentionally omitted from `calls`.
 */
function findCalleeSymbol(
  index: RepositoryIndex,
  callerFilePath: string,
  calleeName: string,
): SymbolEntry | undefined {
  let fallback: SymbolEntry | undefined;
  for (const candidate of index.symbols.values()) {
    if (candidate.name !== calleeName) {
      continue;
    }
    if (candidate.filePath === callerFilePath) {
      return candidate;
    }
    if (!fallback) {
      fallback = candidate;
    }
  }
  return fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
