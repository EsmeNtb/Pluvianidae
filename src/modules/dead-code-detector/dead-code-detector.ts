/**
 * Detector de Código No Utilizado (`modules/dead-code-detector/`).
 *
 * Identifies unused imports, unused variables, unused parameters, unused
 * functions, and orphan files by combining the already-built
 * `RepositoryIndex` (task 2.x) with lightweight, file-local textual/AST
 * analysis. See design.md > "6. Detector de Código No Utilizado
 * (`modules/dead-code-detector/`)" and requirements.md > Requirement 4
 * (4.1, 4.2, 4.5).
 *
 * `CodeWarning` and `UnanalyzableFile` are also defined/exported here
 * (mirroring how `SearchResult`/`RelatedFile` live in `searcher.ts` rather
 * than `models.ts`, since design.md documents them under this component's
 * own section). `warnings` (commented-code / duplicate-code detection,
 * requirements.md 4.3) is populated by delegating to `code-warnings.ts`
 * (task 7.2) using the same per-file cached source text gathered by the
 * main per-file loop below.
 *
 * ## Confidence-level policy (requirements.md 4.2)
 *
 * A single shared classification pipeline is used for every finding type
 * (unused-import, unused-variable, unused-parameter, unused-function):
 *
 *   1. Every whole-word occurrence of a candidate name (excluding its own
 *      declaration site) is classified into one bucket using a simple
 *      character-level tokenizer that tracks comments/strings/templates:
 *        - `comment`  — occurrence sits inside a `//` or `/* *\/` comment.
 *        - `dynamic`  — occurrence sits inside a string/template literal,
 *          OR inside a `require(...)` call, OR inside computed member
 *          access (`obj[name]`). This approximates "referenced dynamically
 *          or indirectly" from requirements.md 4.2. Note: `${name}` inside
 *          a template literal is classified as `dynamic` (a documented
 *          simplification — the tokenizer treats the whole template body,
 *          including `${...}` interpolations, as string content rather
 *          than parsing nested expressions).
 *        - `codeTest` — a genuine code-level occurrence, but inside a file
 *          matching the test-file pattern (`*.test.*` / `*.spec.*`). Only
 *          meaningful for cross-file checks (unused-function).
 *        - `codeReal` — a genuine code-level occurrence anywhere else.
 *   2. `deriveConfidence` maps the aggregated counts to a verdict:
 *        - any `codeReal` → not dead code at all (`null`, no finding).
 *        - else any `codeTest` or `comment` → `'medio'`.
 *        - else any `dynamic` → `'bajo'`.
 *        - else (zero occurrences of any kind) → `'alto'`.
 *   3. Suggested action follows directly from confidence:
 *      alto → 'eliminar', medio → 'comentar', bajo → 'revisar-manualmente'.
 *
 * This is a pragmatic MVP approximation, not a full data-flow analysis. Its
 * known limitations are documented inline near each detector.
 *
 * ## 60-second timeout (requirements.md 4.1)
 *
 * `analyze()` tracks elapsed time while looping over indexed files. If the
 * budget is exceeded before a file is reached, that file (and all
 * remaining ones) is recorded in `unanalyzableFiles` with reason "análisis
 * interrumpido por tiempo" instead of being silently dropped, and the
 * method returns whatever partial `findings`/`unanalyzableFiles` were
 * collected so far — no exception is thrown. The whole-repository checks
 * (unused-function, orphan-file) are skipped entirely if the deadline has
 * already passed by the time the per-file loop finishes, since they scan
 * every file's cached content again.
 *
 * ## Unanalyzable files (requirements.md 4.5)
 *
 * `ts.createSourceFile` rarely throws on malformed input — it produces a
 * best-effort AST with internal parse diagnostics instead. To satisfy
 * "register file as unanalyzable on syntax errors" faithfully (rather than
 * only catching thrown exceptions, as `IndexBuilder` does), this module
 * inspects the parser's internal `parseDiagnostics` array (accessed via a
 * type assertion, since it is not part of the public `typescript` API
 * surface — the same technique used by other TS tooling such as ts-morph)
 * and throws a synthetic error when any are present. That error is caught
 * alongside file-read failures, and the file is pushed to
 * `unanalyzableFiles` and skipped; analysis continues with the rest.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as ts from 'typescript';
import { FileEntry, RepositoryIndex } from '../../core/models';
import { IIndexer } from '../indexer/index-builder';
import { detectCommentedCodeWarnings, detectDuplicateCodeWarnings, FileSource } from './code-warnings';

// ---------------------------------------------------------------------------
// Public interface & report shapes (design.md > "6. Detector de Código No
// Utilizado")
// ---------------------------------------------------------------------------

export interface IDeadCodeDetector {
  analyze(): Promise<DeadCodeReport>;
}

export interface DeadCodeReport {
  findings: DeadCodeFinding[];
  warnings: CodeWarning[];
  unanalyzableFiles: UnanalyzableFile[];
  duration: number;
}

export type DeadCodeFindingType =
  | 'unused-import'
  | 'unused-variable'
  | 'unused-parameter'
  | 'unused-function'
  | 'orphan-file';

export type ConfidenceLevel = 'alto' | 'medio' | 'bajo';

export type SuggestedAction = 'eliminar' | 'comentar' | 'revisar-manualmente';

export interface DeadCodeFinding {
  type: DeadCodeFindingType;
  confidence: ConfidenceLevel;
  filePath: string;
  line: number;
  description: string;
  suggestedAction: SuggestedAction;
}

/**
 * Populated by `code-warnings.ts` (task 7.2), wired into `analyze()` below.
 * Shape taken verbatim from design.md. Note this shape has no `confidence`
 * field — per requirements.md 4.3, every `CodeWarning` is conceptually
 * "bajo" confidence by design/convention (see `code-warnings.ts`'s
 * module-level doc comment), rather than a literal field on this type.
 */
export interface CodeWarning {
  type: 'commented-code' | 'duplicate-code';
  filePath: string;
  startLine: number;
  endLine: number;
  description: string;
  duplicateLocation?: { filePath: string; startLine: number; endLine: number };
}

/**
 * design.md references `UnanalyzableFile` (e.g. in `FBComparisonReport`)
 * without spelling out its shape in the excerpt available for this
 * component. This is a reasonable, minimal shape: enough to report which
 * file failed and why, per requirements.md 4.5's "informar al Usuario".
 */
export interface UnanalyzableFile {
  filePath: string;
  reason: string;
}

/** Requirements.md 4.1: hard 60-second budget for the whole analysis. */
export const DEAD_CODE_ANALYSIS_TIMEOUT_MS = 60_000;

/** Files matching this pattern are treated as tests, not orphans, and their
 *  code-level references count as "referenced only in tests" (medio) rather
 *  than a genuine usage. */
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/i;

// ---------------------------------------------------------------------------
// Injectable file reading (mirrors `Searcher`'s `IFileReader` pattern, but
// async since dead-code analysis reads whole files rather than a few lines)
// ---------------------------------------------------------------------------

export interface IFileContentReader {
  readFile(filePath: string): Promise<string>;
}

export class FsFileContentReader implements IFileContentReader {
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Internal per-file analysis context
// ---------------------------------------------------------------------------

type CharClass = 'code' | 'comment' | 'string';

interface FileAnalysisContext {
  filePath: string;
  sourceText: string;
  classes: CharClass[];
  lineStartOffsets: number[];
  sourceFile: ts.SourceFile;
  isTestFile: boolean;
}

interface RefCounts {
  codeReal: number;
  codeTest: number;
  comment: number;
  dynamic: number;
}

function emptyRefCounts(): RefCounts {
  return { codeReal: 0, codeTest: 0, comment: 0, dynamic: 0 };
}

/** See the class-level doc comment's "Confidence-level policy" section. */
function deriveConfidence(counts: RefCounts): ConfidenceLevel | null {
  if (counts.codeReal > 0) {
    return null;
  }
  if (counts.codeTest > 0 || counts.comment > 0) {
    return 'medio';
  }
  if (counts.dynamic > 0) {
    return 'bajo';
  }
  return 'alto';
}

function suggestedActionFor(confidence: ConfidenceLevel): SuggestedAction {
  switch (confidence) {
    case 'alto':
      return 'eliminar';
    case 'medio':
      return 'comentar';
    case 'bajo':
      return 'revisar-manualmente';
  }
}

// ---------------------------------------------------------------------------
// DeadCodeDetector
// ---------------------------------------------------------------------------

/**
 * Implements `IDeadCodeDetector`. Injects `getIndex` only (same narrow
 * dependency pattern as `Searcher`'s constructor) since this module only
 * ever reads the already-built index, never triggers indexing itself.
 */
export class DeadCodeDetector implements IDeadCodeDetector {
  constructor(
    private readonly indexSource: Pick<IIndexer, 'getIndex'>,
    private readonly fileReader: IFileContentReader = new FsFileContentReader(),
    private readonly timeoutMs: number = DEAD_CODE_ANALYSIS_TIMEOUT_MS,
  ) {}

  async analyze(): Promise<DeadCodeReport> {
    const startTime = Date.now();
    const deadline = startTime + this.timeoutMs;
    const index = this.indexSource.getIndex();

    const findings: DeadCodeFinding[] = [];
    const unanalyzableFiles: UnanalyzableFile[] = [];
    const contexts = new Map<string, FileAnalysisContext>();

    const filePaths = Array.from(index.files.keys());

    for (let i = 0; i < filePaths.length; i++) {
      if (Date.now() >= deadline) {
        for (let j = i; j < filePaths.length; j++) {
          unanalyzableFiles.push({
            filePath: filePaths[j],
            reason: 'Análisis interrumpido: se superó el límite de 60 segundos.',
          });
        }
        break;
      }

      const filePath = filePaths[i];
      const fileEntry = index.files.get(filePath);
      if (!fileEntry) {
        continue;
      }

      let context: FileAnalysisContext;
      try {
        const sourceText = await this.fileReader.readFile(filePath);
        const sourceFile = parseSourceOrThrow(filePath, sourceText);
        context = {
          filePath,
          sourceText,
          classes: classifySourceCharacters(sourceText),
          lineStartOffsets: computeLineStartOffsets(sourceText),
          sourceFile,
          isTestFile: TEST_FILE_PATTERN.test(filePath),
        };
        contexts.set(filePath, context);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        unanalyzableFiles.push({ filePath, reason });
        continue;
      }

      this.detectUnusedImports(context, fileEntry, findings);
      this.detectUnusedVariables(context, findings);
      this.detectUnusedParameters(context, index, findings);
    }

    if (Date.now() < deadline) {
      this.detectUnusedFunctions(index, contexts, findings);
      this.detectOrphanFiles(index, findings);
    }

    const warnings = this.detectCodeWarnings(contexts);

    return {
      findings,
      warnings,
      unanalyzableFiles,
      duration: Date.now() - startTime,
    };
  }

  // -------------------------------------------------------------------
  // Commented / duplicate code warnings (requirements.md 4.3)
  // -------------------------------------------------------------------

  /**
   * Delegates to `code-warnings.ts` using the cached source text already
   * read for every successfully-analyzed file (`contexts`). Files that
   * failed to parse (`unanalyzableFiles`) are absent from `contexts` and
   * are simply not considered here — consistent with how
   * `detectUnusedFunctions` treats them.
   */
  private detectCodeWarnings(contexts: Map<string, FileAnalysisContext>): CodeWarning[] {
    const warnings: CodeWarning[] = [];
    const fileSources: FileSource[] = [];

    for (const context of contexts.values()) {
      warnings.push(...detectCommentedCodeWarnings(context.filePath, context.sourceText));
      fileSources.push({ filePath: context.filePath, sourceText: context.sourceText });
    }

    warnings.push(...detectDuplicateCodeWarnings(fileSources));

    return warnings;
  }

  // -------------------------------------------------------------------
  // Unused imports
  // -------------------------------------------------------------------

  /**
   * For each import specifier, searches the whole file (excluding the
   * import declaration's own line) for whole-word occurrences. Zero
   * occurrences of any kind → unused with confidence per
   * `deriveConfidence`. Multi-line import statements are not specially
   * handled — only the single line reported by `ImportEntry.line` is
   * excluded, a documented MVP simplification.
   */
  private detectUnusedImports(context: FileAnalysisContext, fileEntry: FileEntry, findings: DeadCodeFinding[]): void {
    for (const importEntry of fileEntry.imports) {
      const [lineStart, lineEnd] = lineRange(context.lineStartOffsets, context.sourceText, importEntry.line);

      for (const specifier of importEntry.specifiers) {
        if (!specifier) {
          continue;
        }
        const indices = this.findOccurrences(context, specifier).filter(
          (idx) => idx < lineStart || idx >= lineEnd,
        );
        const counts = this.classifyMatches(context, specifier, indices, false);
        const confidence = deriveConfidence(counts);
        if (confidence) {
          findings.push({
            type: 'unused-import',
            confidence,
            filePath: context.filePath,
            line: importEntry.line,
            description: `El import "${specifier}" de "${importEntry.source}" no se utiliza en este archivo.`,
            suggestedAction: suggestedActionFor(confidence),
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // Unused variables
  // -------------------------------------------------------------------

  /**
   * `SymbolExtractor` only tags function-like variable declarations as
   * `'function'`/`'component'` symbols; plain data variables (`const x =
   * 5`) are not indexed at all. This detector therefore performs its own
   * lightweight AST scan of `VariableDeclaration` nodes with a plain
   * identifier name (destructuring patterns are skipped — MVP
   * simplification) and a non-function-like initializer, to avoid
   * duplicating what `unused-function` already covers.
   */
  private detectUnusedVariables(context: FileAnalysisContext, findings: DeadCodeFinding[]): void {
    const declarations = collectPlainVariableDeclarations(context.sourceFile);

    for (const declaration of declarations) {
      const [lineStart, lineEnd] = lineRange(context.lineStartOffsets, context.sourceText, declaration.line);
      const indices = this.findOccurrences(context, declaration.name).filter(
        (idx) => idx < lineStart || idx >= lineEnd,
      );
      const counts = this.classifyMatches(context, declaration.name, indices, false);
      const confidence = deriveConfidence(counts);
      if (confidence) {
        findings.push({
          type: 'unused-variable',
          confidence,
          filePath: context.filePath,
          line: declaration.line,
          description: `La variable "${declaration.name}" no se utiliza en este archivo.`,
          suggestedAction: suggestedActionFor(confidence),
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // Unused parameters
  // -------------------------------------------------------------------

  /**
   * Reuses `SymbolEntry.parameters` already extracted by the indexer.
   * Searches only within the function's own body range (`line`..`endLine`)
   * so unrelated same-named identifiers elsewhere in the file are ignored.
   * The parameter's own declaration-site occurrence (in the signature) is
   * the earliest match within that range and is excluded before
   * classifying the rest — this correctly yields "zero additional
   * references" (`alto`) when the parameter is never used in the body,
   * without needing to know the exact column of the signature.
   */
  private detectUnusedParameters(
    context: FileAnalysisContext,
    index: RepositoryIndex,
    findings: DeadCodeFinding[],
  ): void {
    const fileEntry = index.files.get(context.filePath);
    if (!fileEntry) {
      return;
    }

    for (const symbolId of fileEntry.symbols) {
      const symbol = index.symbols.get(symbolId);
      if (!symbol || !symbol.parameters || symbol.parameters.length === 0) {
        continue;
      }

      const [bodyStart] = lineRange(context.lineStartOffsets, context.sourceText, symbol.line);
      const [, bodyEnd] = lineRange(context.lineStartOffsets, context.sourceText, symbol.endLine);

      for (const param of symbol.parameters) {
        // Skip destructured/rest parameter names (e.g. "{ a, b }", "...rest")
        // — not plain identifiers, out of scope for this MVP heuristic.
        if (!param.name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param.name)) {
          continue;
        }

        const indices = this.findOccurrences(context, param.name, bodyStart, bodyEnd);
        if (indices.length === 0) {
          // Declaration occurrence itself wasn't found textually (e.g. the
          // name overlaps a `?`/type annotation edge case) — nothing to
          // safely conclude, skip.
          continue;
        }
        // Exclude the earliest occurrence (the declaration site in the signature).
        const usageIndices = indices.slice(1);
        const counts = this.classifyMatches(context, param.name, usageIndices, false);
        const confidence = deriveConfidence(counts);
        if (confidence) {
          findings.push({
            type: 'unused-parameter',
            confidence,
            filePath: context.filePath,
            line: symbol.line,
            description: `El parámetro "${param.name}" de "${symbol.name}" no se utiliza en el cuerpo de la función.`,
            suggestedAction: suggestedActionFor(confidence),
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // Unused functions (whole-repository)
  // -------------------------------------------------------------------

  /**
   * For every indexed `'function'` symbol, searches across every
   * *successfully analyzed* file's cached content for whole-word
   * occurrences of its name (excluding the declaration's own line in its
   * own file — a recursive call elsewhere in its own body still counts as
   * a real usage). Files that failed to parse (`unanalyzableFiles`) are
   * simply absent from `contexts` and contribute no evidence either way —
   * a documented MVP limitation. Exported-but-never-imported functions are
   * still flagged as unused per requirements.md 4.1 ("funciones no
   * invocadas"), since export alone is not usage.
   */
  private detectUnusedFunctions(
    index: RepositoryIndex,
    contexts: Map<string, FileAnalysisContext>,
    findings: DeadCodeFinding[],
  ): void {
    for (const symbol of index.symbols.values()) {
      if (symbol.type !== 'function') {
        continue;
      }
      const declarationContext = contexts.get(symbol.filePath);
      if (!declarationContext) {
        // Declaration file itself was unanalyzable; nothing reliable to report.
        continue;
      }

      const aggregate = emptyRefCounts();
      for (const fileContext of contexts.values()) {
        let indices = this.findOccurrences(fileContext, symbol.name);
        if (fileContext.filePath === symbol.filePath) {
          const [declStart, declEnd] = lineRange(fileContext.lineStartOffsets, fileContext.sourceText, symbol.line);
          indices = indices.filter((idx) => idx < declStart || idx >= declEnd);
        }
        const counts = this.classifyMatches(fileContext, symbol.name, indices, fileContext.isTestFile);
        aggregate.codeReal += counts.codeReal;
        aggregate.codeTest += counts.codeTest;
        aggregate.comment += counts.comment;
        aggregate.dynamic += counts.dynamic;
      }

      const confidence = deriveConfidence(aggregate);
      if (confidence) {
        findings.push({
          type: 'unused-function',
          confidence,
          filePath: symbol.filePath,
          line: symbol.line,
          description: `La función "${symbol.name}" no se invoca en ningún lugar del repositorio.`,
          suggestedAction: suggestedActionFor(confidence),
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // Orphan files
  // -------------------------------------------------------------------

  /**
   * Flags any indexed file with zero incoming edges in `index.importGraph`
   * as an orphan, except files matching the test-file pattern (test files
   * are used by the test runner even though no source file imports them).
   * Known MVP limitation (documented in the task and design.md): legitimate
   * entry-point files (extension `main`, config files) may be flagged as
   * false positives — the confidence-level system communicates this
   * uncertainty rather than special-casing specific file names.
   */
  private detectOrphanFiles(index: RepositoryIndex, findings: DeadCodeFinding[]): void {
    const importedTargets = new Set<string>();
    for (const targets of index.importGraph.values()) {
      for (const target of targets) {
        importedTargets.add(target);
      }
    }

    for (const filePath of index.files.keys()) {
      if (importedTargets.has(filePath)) {
        continue;
      }
      if (TEST_FILE_PATTERN.test(filePath)) {
        continue;
      }
      findings.push({
        type: 'orphan-file',
        confidence: 'alto',
        filePath,
        line: 1,
        description: `El archivo "${filePath}" no es importado ni referenciado por ningún otro archivo del repositorio.`,
        suggestedAction: 'revisar-manualmente',
      });
    }
  }

  // -------------------------------------------------------------------
  // Shared textual-search / classification primitives
  // -------------------------------------------------------------------

  /** Whole-word occurrence indices of `name` within `[start, end)` of `context.sourceText`, ascending. */
  private findOccurrences(
    context: FileAnalysisContext,
    name: string,
    start = 0,
    end: number = context.sourceText.length,
  ): number[] {
    const regex = buildWholeWordRegex(name);
    const indices: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(context.sourceText)) !== null) {
      if (match.index >= end) {
        break;
      }
      if (match.index >= start) {
        indices.push(match.index);
      }
    }
    return indices;
  }

  /** Classifies each occurrence index per the "Confidence-level policy" doc comment above. */
  private classifyMatches(
    context: FileAnalysisContext,
    name: string,
    indices: number[],
    treatCodeAsTest: boolean,
  ): RefCounts {
    const counts = emptyRefCounts();

    for (const idx of indices) {
      const charClass = context.classes[idx];
      if (charClass === 'comment') {
        counts.comment++;
        continue;
      }
      if (charClass === 'string') {
        counts.dynamic++;
        continue;
      }

      const windowStart = Math.max(0, idx - 60);
      const windowEnd = Math.min(context.sourceText.length, idx + name.length + 60);
      const window = context.sourceText.slice(windowStart, windowEnd);

      if (isDynamicCodeUsage(window, name)) {
        counts.dynamic++;
      } else if (treatCodeAsTest) {
        counts.codeTest++;
      } else {
        counts.codeReal++;
      }
    }

    return counts;
  }
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/**
 * Parses `sourceText` and throws a descriptive error if the TypeScript
 * parser recorded syntax diagnostics, so callers can register the file as
 * unanalyzable (requirements.md 4.5). See the class-level doc comment's
 * "Unanalyzable files" section for why `parseDiagnostics` (an internal,
 * non-public field) is used here.
 */
function parseSourceOrThrow(filePath: string, sourceText: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    getScriptKind(filePath),
  );

  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    const message = diagnostics
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
      .join('; ');
    throw new Error(`Error de sintaxis: ${message}`);
  }

  return sourceFile;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.Unknown;
  }
}

interface PlainVariableDeclaration {
  name: string;
  line: number;
}

/**
 * Collects `VariableDeclaration` nodes with a plain identifier name whose
 * initializer (if any) is not a function/arrow expression — those are
 * already captured as `'function'`/`'component'` symbols by
 * `SymbolExtractor` and are handled by `detectUnusedFunctions` instead.
 * Destructuring patterns (`const { a, b } = x`) are skipped for this MVP.
 */
function collectPlainVariableDeclarations(sourceFile: ts.SourceFile): PlainVariableDeclaration[] {
  const declarations: PlainVariableDeclaration[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      const isFunctionLike =
        initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
      if (!isFunctionLike) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        declarations.push({ name: node.name.text, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return declarations;
}

// ---------------------------------------------------------------------------
// Character-level source classification (comments / strings / code)
// ---------------------------------------------------------------------------

/**
 * Classifies every character of `text` as belonging to a line comment, a
 * block comment, a string/template literal, or plain code, via a single
 * left-to-right scan. This is a simplified tokenizer (not a full lexer): it
 * does not attempt to parse `${...}` interpolations within template
 * literals as code — see the class-level doc comment for why that is an
 * acceptable MVP simplification here.
 */
function classifySourceCharacters(text: string): CharClass[] {
  const classes: CharClass[] = new Array(text.length);
  type State = 'code' | 'line-comment' | 'block-comment' | 'string-single' | 'string-double' | 'template';
  let state: State = 'code';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          classes[i] = 'comment';
          classes[i + 1] = 'comment';
          state = 'line-comment';
          i++;
        } else if (ch === '/' && next === '*') {
          classes[i] = 'comment';
          classes[i + 1] = 'comment';
          state = 'block-comment';
          i++;
        } else if (ch === "'") {
          classes[i] = 'string';
          state = 'string-single';
        } else if (ch === '"') {
          classes[i] = 'string';
          state = 'string-double';
        } else if (ch === '`') {
          classes[i] = 'string';
          state = 'template';
        } else {
          classes[i] = 'code';
        }
        break;

      case 'line-comment':
        classes[i] = 'comment';
        if (ch === '\n') {
          state = 'code';
        }
        break;

      case 'block-comment':
        classes[i] = 'comment';
        if (ch === '*' && next === '/') {
          classes[i + 1] = 'comment';
          state = 'code';
          i++;
        }
        break;

      case 'string-single':
        classes[i] = 'string';
        if (ch === '\\') {
          if (i + 1 < text.length) {
            classes[i + 1] = 'string';
          }
          i++;
        } else if (ch === "'") {
          state = 'code';
        }
        break;

      case 'string-double':
        classes[i] = 'string';
        if (ch === '\\') {
          if (i + 1 < text.length) {
            classes[i + 1] = 'string';
          }
          i++;
        } else if (ch === '"') {
          state = 'code';
        }
        break;

      case 'template':
        classes[i] = 'string';
        if (ch === '\\') {
          if (i + 1 < text.length) {
            classes[i + 1] = 'string';
          }
          i++;
        } else if (ch === '`') {
          state = 'code';
        }
        break;
    }
  }

  return classes;
}

/** Offsets (into `text`) where each 1-indexed line starts; `offsets[0]` is always 0. */
function computeLineStartOffsets(text: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

/** `[startOffset, endOffsetExclusive)` of `oneIndexedLine` within `text`, using precomputed `lineStartOffsets`. */
function lineRange(lineStartOffsets: number[], text: string, oneIndexedLine: number): [number, number] {
  const idx = oneIndexedLine - 1;
  const start = lineStartOffsets[idx] ?? text.length;
  const end = lineStartOffsets[idx + 1] ?? text.length;
  return [start, end];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches `name` as a whole identifier (custom boundary so `$`/digits adjacent to the name don't false-match). */
function buildWholeWordRegex(name: string): RegExp {
  const escaped = escapeRegExp(name);
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, 'g');
}

/**
 * Heuristic for "referenced dynamically or indirectly" (requirements.md
 * 4.2) among code-classified occurrences: true if `window` (a small slice
 * of source text centered on the match) looks like a `require(...)` call
 * argument or a computed member access (`obj[name]`) involving `name`.
 */
function isDynamicCodeUsage(window: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  const requirePattern = new RegExp(`require\\s*\\([^)]*\\b${escaped}\\b[^)]*\\)`);
  const computedAccessPattern = new RegExp(`\\[\\s*${escaped}\\s*\\]`);
  return requirePattern.test(window) || computedAccessPattern.test(window);
}
