/**
 * Buscador (semantic + exact search) module.
 *
 * Answers natural-language and exact-text queries against the repository
 * index: `search()` uses Amazon Bedrock to interpret the query semantically
 * over a curated set of candidate symbols, while `searchExact()` performs a
 * synchronous case-insensitive substring match over symbol names with no
 * external dependency. See design.md > "4. Buscador (`modules/searcher/`)"
 * and requirements.md > Requirement 2 (2.1-2.6).
 *
 * Design deviations from design.md's `ISearcher`/`SearchResult` shapes
 * (documented here since they resolve genuine ambiguities in the design
 * rather than being arbitrary changes):
 *
 *   1. **Suggestions (2.4)** — `SearchResult` has no field for "alternative
 *      query suggestions", and changing `search`/`searchExact` to return a
 *      wrapper object would break the `ISearcher` interface design.md
 *      specifies verbatim. Instead, suggestions are exposed via a separate
 *      `getSuggestions(query)` method that a caller (e.g. the command
 *      handler / webview) invokes whenever `search`/`searchExact` returns
 *      an empty array, satisfying "always suggest alternative queries
 *      alongside results" without altering the specified return types.
 *
 *   2. **`RelatedFile.relationship: 'dependency'`** — design.md defines
 *      three relationship kinds but Property 8 only requires "exactly
 *      those files with a *direct* import/dependency relationship" per the
 *      import graph. The import graph only models direct `imports` edges
 *      (and their inverse, `imported-by`); there is no separate notion of
 *      a "dependency" distinct from a direct import at the index level.
 *      `computeRelatedFiles` therefore only ever produces `'imports'` and
 *      `'imported-by'` entries — `'dependency'` is reserved in the type for
 *      a future indirect/transitive-dependency feature and intentionally
 *      unused here.
 *
 *   3. **5s (Searcher) vs 10s (BedrockClient) timeout reconciliation** —
 *      requirements.md 2.5 gives `search()` a 5-second user-facing budget,
 *      while `BedrockClient.query()` enforces its own internal 10-second
 *      timeout (requirements.md 2.6 / task 5.1). Rather than trying to
 *      shorten BedrockClient's timeout (which is shared with other Bedrock
 *      consumers like the README generator and explainer, each with their
 *      own budgets), the Searcher races the *entire* semantic-search flow
 *      (candidate selection + confirmation prompt + Bedrock call + response
 *      parsing) against its own 5-second clock. If that clock elapses
 *      first, `search()` treats it exactly like Bedrock being unavailable
 *      and falls back to `searchExact()` (requirements.md 2.6). Note this
 *      means a slow-to-respond user confirmation dialog can also trigger
 *      the fallback while the underlying Bedrock call keeps running in the
 *      background and its result is simply discarded — an accepted MVP
 *      simplification given the interface has no cancellation token.
 */

import * as fs from 'fs';
import { RepositoryIndex, SymbolEntry, SymbolType } from '../../core/models';
import { IIndexer } from '../indexer/index-builder';
import { BedrockContext, IBedrockClient } from '../../services/bedrock-client';

export interface ISearcher {
  search(query: string): Promise<SearchResult[]>;
  searchExact(query: string): SearchResult[];
}

export interface SearchResult {
  filePath: string;
  fullPath: string;
  symbolName: string;
  symbolType: SymbolType;
  /** Máx 20 líneas (`MAX_SNIPPET_LINES`). */
  codeSnippet: string;
  explanation: string;
  relatedFiles: RelatedFile[];
}

export interface RelatedFile {
  path: string;
  relationship: 'imports' | 'imported-by' | 'dependency';
}

/** Requirements.md 2.2 / design.md: code snippets are truncated to at most this many lines. */
export const MAX_SNIPPET_LINES = 20;

/** Requirements.md 2.5: `search()`'s own user-facing response-time budget. */
export const SEARCH_TIMEOUT_MS = 5_000;

/** Number of candidate symbols sent to Bedrock as semantic-search context. */
const MAX_CANDIDATES = 8;

/** Generic suggestions shown when no name-based suggestion can be derived from the query. */
const GENERIC_SUGGESTIONS: readonly string[] = [
  'Intenta con un término más general, como el nombre de una función o componente.',
  'Verifica la ortografía de la consulta.',
  'Prueba buscando por el nombre de un archivo o módulo relacionado.',
];

/**
 * Injectable abstraction over reading a source file's lines, so `Searcher`
 * can be unit tested without touching the real file system (mirrors
 * `BedrockClient`'s injectable `IBedrockRuntimeClient`/`IConfirmationPrompt`
 * pattern). `searchExact` is specified as synchronous in design.md, so this
 * reads synchronously rather than returning a `Promise`.
 */
export interface IFileReader {
  readFileLines(filePath: string): string[];
}

/** Default `IFileReader` backed by `fs.readFileSync`. */
export class FsFileReader implements IFileReader {
  readFileLines(filePath: string): string[] {
    return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  }
}

/** Shape Bedrock is prompted to return for each relevant semantic match. */
interface SemanticMatch {
  symbolName: string;
  filePath: string;
  explanation: string;
}

/**
 * Implements `ISearcher`: exact textual search over the index (no external
 * dependency) plus Bedrock-backed semantic search with a graceful fallback
 * to exact search when Bedrock is unavailable, times out, is cancelled by
 * the user, or returns an unparseable response.
 */
export class Searcher implements ISearcher {
  constructor(
    private readonly indexSource: Pick<IIndexer, 'getIndex'>,
    private readonly bedrockClient: IBedrockClient,
    private readonly fileReader: IFileReader = new FsFileReader(),
    private readonly searchTimeoutMs: number = SEARCH_TIMEOUT_MS,
  ) {}

  /**
   * Case-insensitive substring match of `query` against every indexed
   * symbol's name. Synchronous per design.md's `ISearcher.searchExact`
   * signature.
   */
  searchExact(query: string): SearchResult[] {
    const index = this.indexSource.getIndex();
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const results: SearchResult[] = [];
    for (const symbol of index.symbols.values()) {
      if (symbol.name.toLowerCase().includes(normalizedQuery)) {
        results.push(
          this.buildResult(
            index,
            symbol,
            `Coincidencia textual con "${query}" en el símbolo "${symbol.name}".`,
          ),
        );
      }
    }
    return results;
  }

  /**
   * Semantic search via Bedrock, using the repository index as context.
   * Falls back to `searchExact` when Bedrock is unavailable, the 5s budget
   * elapses, the user cancels the transmission confirmation, or Bedrock's
   * response can't be parsed into results — all treated as "Bedrock
   * unavailable" per requirements.md 2.6.
   */
  async search(query: string): Promise<SearchResult[]> {
    const available = await this.bedrockClient.isAvailable();
    if (!available) {
      return this.searchExact(query);
    }

    try {
      return await this.withTimeout(this.semanticSearch(query), this.searchTimeoutMs);
    } catch {
      return this.searchExact(query);
    }
  }

  /**
   * Alternative query suggestions for when `search`/`searchExact` returned
   * no results (requirements.md 2.4). See the class-level doc comment for
   * why this is a separate method rather than a field on `SearchResult`.
   */
  getSuggestions(query: string, limit = 5): string[] {
    const index = this.indexSource.getIndex();
    const queryWords = query.toLowerCase().split(/\s+/).filter((word) => word.length >= 3);

    const nameMatches: string[] = [];
    if (queryWords.length > 0) {
      for (const symbol of index.symbols.values()) {
        const name = symbol.name.toLowerCase();
        const isRelated = queryWords.some((word) => name.includes(word) || word.includes(name));
        if (isRelated && !nameMatches.includes(symbol.name)) {
          nameMatches.push(symbol.name);
        }
        if (nameMatches.length >= limit) {
          break;
        }
      }
    }

    return nameMatches.length > 0 ? nameMatches : [...GENERIC_SUGGESTIONS];
  }

  // -------------------------------------------------------------------
  // Semantic search internals
  // -------------------------------------------------------------------

  private async semanticSearch(query: string): Promise<SearchResult[]> {
    const index = this.indexSource.getIndex();
    const candidates = this.selectCandidates(index, query, MAX_CANDIDATES);
    if (candidates.length === 0) {
      return [];
    }

    const prompt = this.buildPrompt(query, candidates);
    const context: BedrockContext = {
      files: [...new Set(candidates.map((candidate) => candidate.filePath))],
      codeSnippets: candidates.map((candidate) => this.readSnippet(candidate.filePath, candidate.line)),
      requiresConfirmation: true,
    };

    const response = await this.bedrockClient.query(prompt, context);
    const matches = parseSemanticResponse(response);
    if (!matches) {
      // Unparseable response: degrade to the exact-text fallback rather
      // than surfacing a confusing empty/garbled result to the user.
      throw new Error('Unparseable Bedrock semantic search response.');
    }

    const results: SearchResult[] = [];
    for (const match of matches) {
      const symbol = candidates.find(
        (candidate) => candidate.name === match.symbolName && candidate.filePath === match.filePath,
      );
      if (!symbol) {
        // Ignore hallucinated matches that don't correspond to a candidate
        // actually sent to Bedrock.
        continue;
      }
      const explanation =
        match.explanation.trim().length > 0
          ? match.explanation
          : `Coincidencia semántica para "${query}" en el símbolo "${symbol.name}".`;
      results.push(this.buildResult(index, symbol, explanation));
    }
    return results;
  }

  private selectCandidates(index: RepositoryIndex, query: string, limit: number): SymbolEntry[] {
    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (queryWords.length === 0) {
      return [];
    }

    const scored: Array<{ symbol: SymbolEntry; score: number }> = [];
    for (const symbol of index.symbols.values()) {
      const name = symbol.name.toLowerCase();
      let score = 0;
      for (const word of queryWords) {
        if (name.includes(word)) {
          score += 1;
        }
      }
      if (score > 0) {
        scored.push({ symbol, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((entry) => entry.symbol);
  }

  private buildPrompt(query: string, candidates: SymbolEntry[]): string {
    const candidateDescriptions = candidates
      .map((candidate, index) => {
        const snippet = this.readSnippet(candidate.filePath, candidate.line);
        return (
          `${index + 1}. symbolName: "${candidate.name}", filePath: "${candidate.filePath}", ` +
          `type: "${candidate.type}"\n${snippet}`
        );
      })
      .join('\n\n');

    return [
      'Eres un asistente que ayuda a encontrar código relevante en un repositorio.',
      `Consulta del usuario: "${query}"`,
      'A continuación se listan símbolos candidatos con su código:',
      candidateDescriptions,
      'Responde ÚNICAMENTE con un array JSON (sin texto adicional) de objetos con la forma:',
      '[{ "symbolName": string, "filePath": string, "explanation": string }]',
      'Incluye solo los símbolos realmente relevantes para la consulta, generando una breve ' +
        'explicación en español para cada uno. Si ninguno es relevante, responde con [].',
    ].join('\n\n');
  }

  // -------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------

  private buildResult(index: RepositoryIndex, symbol: SymbolEntry, explanation: string): SearchResult {
    const fileEntry = index.files.get(symbol.filePath);
    const filePath = fileEntry?.relativePath ?? symbol.filePath;

    return {
      filePath,
      fullPath: symbol.filePath,
      symbolName: symbol.name,
      symbolType: symbol.type,
      codeSnippet: this.readSnippet(symbol.filePath, symbol.line),
      explanation,
      relatedFiles: this.computeRelatedFiles(index, symbol.filePath),
    };
  }

  private readSnippet(filePath: string, startLine: number): string {
    try {
      const lines = this.fileReader.readFileLines(filePath);
      const start = Math.max(0, startLine - 1);
      return lines.slice(start, start + MAX_SNIPPET_LINES).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Direct import-graph relationships for `filePath` only (see class-level
   * doc comment #2 for why `'dependency'` is never produced here).
   */
  private computeRelatedFiles(index: RepositoryIndex, filePath: string): RelatedFile[] {
    const related: RelatedFile[] = [];

    for (const importedPath of index.importGraph.get(filePath) ?? []) {
      related.push({ path: importedPath, relationship: 'imports' });
    }

    for (const [otherFile, importedFiles] of index.importGraph) {
      if (otherFile !== filePath && importedFiles.includes(filePath)) {
        related.push({ path: otherFile, relationship: 'imported-by' });
      }
    }

    return related;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Search exceeded ${timeoutMs}ms budget.`)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutHandle));
  }
}

/**
 * Parses Bedrock's free-form response into `SemanticMatch[]`, tolerating a
 * markdown code-fence wrapper (a common LLM output quirk) around the JSON.
 * Returns `null` (rather than `[]`) when the response isn't valid JSON or
 * isn't an array, so callers can distinguish "no relevant matches" from
 * "couldn't understand the response" and fall back accordingly.
 */
function parseSemanticResponse(raw: string): SemanticMatch[] | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed
      .filter(
        (item): item is { symbolName: string; filePath: string; explanation?: unknown } =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { symbolName?: unknown }).symbolName === 'string' &&
          typeof (item as { filePath?: unknown }).filePath === 'string',
      )
      .map((item) => ({
        symbolName: item.symbolName,
        filePath: item.filePath,
        explanation: typeof item.explanation === 'string' ? item.explanation : '',
      }));
  } catch {
    return null;
  }
}
