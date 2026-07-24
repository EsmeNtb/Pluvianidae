/**
 * AST-based symbol extraction for the Indexador module.
 *
 * Uses the TypeScript compiler API (`typescript` package) to parse a single
 * source file's text and extract the structural elements the rest of the
 * Indexador needs to build a `RepositoryIndex`:
 *
 *   - Functions (declarations, function expressions, arrow functions
 *     assigned to a variable, and class methods)
 *   - Classes
 *   - React components (a best-effort heuristic layered on top of function
 *     and class extraction, see `looksLikeComponent` below)
 *   - Import declarations
 *   - Export declarations (named, default, and `export` modifiers on
 *     declarations)
 *   - Express/Node.js-style HTTP endpoints (`app.get('/path', ...)`, etc.)
 *
 * The TypeScript parser is used (rather than a separate JS parser like
 * Babel/acorn) so that JS, JSX, TS and TSX are all handled through a single,
 * unified code path, per design.md > "3. Indexador".
 *
 * Line numbers are 1-indexed and columns are 1-indexed (the TypeScript
 * compiler API reports both 0-indexed; we add 1 to each so that locations
 * match what an editor status bar shows).
 *
 * Deeper backend parameter/body/response schema extraction is out of scope
 * here — that is handled by `frontend-backend-comparator/backend-extractor`
 * (task 8.1). This module's endpoint detection is intentionally lightweight:
 * it just records that an endpoint exists, its route, method and location.
 *
 * See design.md > "3. Indexador" and requirements.md > Requirement 1.2.
 */

import * as path from 'path';
import * as ts from 'typescript';
import {
  EndpointEntry,
  ExportEntry,
  HttpMethod,
  ImportEntry,
  ParameterInfo,
  SymbolEntry,
  SymbolType,
} from '../../core/models';

export interface SymbolExtractionResult {
  symbols: SymbolEntry[];
  imports: ImportEntry[];
  exports: ExportEntry[];
  endpoints: EndpointEntry[];
}

export interface ISymbolExtractor {
  /**
   * Parses `sourceText` (the contents of the file at `filePath`) and
   * extracts all symbols, imports, exports and endpoints it defines.
   */
  extractFromSource(filePath: string, sourceText: string): SymbolExtractionResult;
}

/** HTTP verb method names recognized as Express/Node.js route handlers. */
const HTTP_VERB_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'delete', 'patch']);

/**
 * Identifier names for the "app"/"router" receiver object in an endpoint
 * call expression (e.g. `app.get(...)`, `router.post(...)`). Restricting to
 * these conventional names keeps the heuristic from matching unrelated calls
 * such as `map.get('/x')` or `cache.delete('/x')`.
 */
const ROUTER_RECEIVER_PATTERN = /router|app|route/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class SymbolExtractor implements ISymbolExtractor {
  extractFromSource(filePath: string, sourceText: string): SymbolExtractionResult {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      getScriptKind(filePath),
    );

    const symbols: SymbolEntry[] = [];
    const imports: ImportEntry[] = [];
    const exports: ExportEntry[] = [];
    const endpoints: EndpointEntry[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        extractImport(node, sourceFile, imports);
      } else if (ts.isExportDeclaration(node)) {
        extractNamedExportDeclaration(node, sourceFile, exports);
      } else if (ts.isExportAssignment(node)) {
        extractExportAssignment(node, sourceFile, exports);
      } else if (ts.isFunctionDeclaration(node)) {
        extractFunctionDeclaration(node, sourceFile, filePath, symbols, exports);
      } else if (ts.isClassDeclaration(node)) {
        extractClassDeclaration(node, sourceFile, filePath, symbols, exports);
      } else if (ts.isVariableStatement(node)) {
        extractVariableStatement(node, sourceFile, filePath, symbols, exports);
      } else if (ts.isCallExpression(node)) {
        extractEndpointCall(node, sourceFile, filePath, endpoints, symbols);
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    return { symbols, imports, exports, endpoints };
  }
}

/** Convenience function form, for callers that don't need a class instance. */
export function extractSymbols(filePath: string, sourceText: string): SymbolExtractionResult {
  return new SymbolExtractor().extractFromSource(filePath, sourceText);
}

// ---------------------------------------------------------------------------
// Script kind detection
// ---------------------------------------------------------------------------

function getScriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
      return ts.ScriptKind.JSX; // allow JSX syntax in .js files (common in React codebases)
    default:
      return ts.ScriptKind.Unknown;
  }
}

// ---------------------------------------------------------------------------
// Location / id helpers
// ---------------------------------------------------------------------------

interface Position {
  line: number;
  column: number;
}

/** 1-indexed line and column of `node`'s start position. */
function getStartPosition(node: ts.Node, sourceFile: ts.SourceFile): Position {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/** 1-indexed line of `node`'s end position. */
function getEndLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

/** Deterministic id for a symbol: `${filePath}#${name}@${line}`. */
function makeSymbolId(filePath: string, name: string, line: number): string {
  return `${filePath}#${name}@${line}`;
}

// ---------------------------------------------------------------------------
// Modifier helpers (export / default keywords)
// ---------------------------------------------------------------------------

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return modifiers !== undefined && modifiers.some((m) => m.kind === kind);
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isDefaultExport(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

// ---------------------------------------------------------------------------
// Component heuristic
// ---------------------------------------------------------------------------

/**
 * Best-effort React component detector for the MVP: a function/class is
 * treated as a component when its name starts with an uppercase letter AND
 * either (a) it appears to return JSX somewhere in its body, or (b) — for
 * classes — it extends `React.Component`/`Component`/`PureComponent`.
 *
 * This is intentionally simple. It will miss components that return JSX
 * conditionally through a helper it can't see, and could (rarely)
 * misclassify a non-component function that happens to build JSX-shaped
 * markup. That tradeoff is acceptable for an MVP heuristic.
 */
function looksLikeComponent(name: string | undefined, body: ts.Node | undefined, extendsReactComponent = false): boolean {
  if (!name || !/^[A-Z]/.test(name)) {
    return false;
  }
  if (extendsReactComponent) {
    return true;
  }
  return body !== undefined && containsJsx(body);
}

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (found) {
      return;
    }
    if (containsJsx(child)) {
      found = true;
    }
  });
  return found;
}

function extendsReactComponentClass(node: ts.ClassDeclaration): boolean {
  const heritage = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  if (!heritage) {
    return false;
  }
  return heritage.types.some((type) => {
    const text = type.expression.getText();
    return /(^|\.)(Component|PureComponent)$/.test(text);
  });
}

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

/**
 * Extracts best-effort `ParameterInfo` for a function-like node's
 * parameters. `ParameterInfo.source` is part of the shared schema used for
 * HTTP endpoint parameters (query/params/body/header); for plain function
 * parameters it doesn't have a meaningful value, so it defaults to `'query'`
 * as a placeholder — callers extracting real endpoint parameters (task 8.1)
 * should compute it properly.
 */
function extractParameters(node: ts.SignatureDeclarationBase, sourceFile: ts.SourceFile): ParameterInfo[] {
  return node.parameters.map((param) => ({
    name: param.name.getText(sourceFile),
    type: param.type ? param.type.getText(sourceFile) : 'any',
    required: !param.questionToken && !param.initializer,
    source: 'query',
  }));
}

function extractReturnType(node: ts.SignatureDeclarationBase, sourceFile: ts.SourceFile): string | undefined {
  return node.type ? node.type.getText(sourceFile) : undefined;
}

// ---------------------------------------------------------------------------
// Function declarations
// ---------------------------------------------------------------------------

function extractFunctionDeclaration(
  node: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  symbols: SymbolEntry[],
  exports: ExportEntry[],
): void {
  const name = node.name?.text ?? 'default';
  const { line, column } = getStartPosition(node, sourceFile);
  const type: SymbolType = looksLikeComponent(node.name?.text, node.body) ? 'component' : 'function';

  symbols.push({
    id: makeSymbolId(filePath, name, line),
    name,
    type,
    filePath,
    line,
    column,
    endLine: getEndLine(node, sourceFile),
    parameters: extractParameters(node, sourceFile),
    returnType: extractReturnType(node, sourceFile),
  });

  if (isExported(node)) {
    exports.push({ name, isDefault: isDefaultExport(node), line });
  }
}

// ---------------------------------------------------------------------------
// Class declarations (+ methods)
// ---------------------------------------------------------------------------

function extractClassDeclaration(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  symbols: SymbolEntry[],
  exports: ExportEntry[],
): void {
  const name = node.name?.text ?? 'default';
  const { line, column } = getStartPosition(node, sourceFile);
  const type: SymbolType = looksLikeComponent(node.name?.text, node, extendsReactComponentClass(node))
    ? 'component'
    : 'class';

  symbols.push({
    id: makeSymbolId(filePath, name, line),
    name,
    type,
    filePath,
    line,
    column,
    endLine: getEndLine(node, sourceFile),
  });

  if (isExported(node)) {
    exports.push({ name, isDefault: isDefaultExport(node), line });
  }

  for (const member of node.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const methodName = member.name.text;
      const methodPos = getStartPosition(member, sourceFile);
      symbols.push({
        id: makeSymbolId(filePath, `${name}.${methodName}`, methodPos.line),
        name: methodName,
        type: 'function',
        filePath,
        line: methodPos.line,
        column: methodPos.column,
        endLine: getEndLine(member, sourceFile),
        parameters: extractParameters(member, sourceFile),
        returnType: extractReturnType(member, sourceFile),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Variable statements (const/let/var foo = function/arrow function)
// ---------------------------------------------------------------------------

function extractVariableStatement(
  node: ts.VariableStatement,
  sourceFile: ts.SourceFile,
  filePath: string,
  symbols: SymbolEntry[],
  exports: ExportEntry[],
): void {
  const exported = isExported(node);

  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
      continue;
    }

    const initializer = declaration.initializer;
    const isFunctionLike = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer);
    if (!isFunctionLike) {
      continue;
    }

    const name = declaration.name.text;
    const { line, column } = getStartPosition(declaration, sourceFile);
    const body = initializer.body;
    const type: SymbolType = looksLikeComponent(name, body) ? 'component' : 'function';

    symbols.push({
      id: makeSymbolId(filePath, name, line),
      name,
      type,
      filePath,
      line,
      column,
      endLine: getEndLine(initializer, sourceFile),
      parameters: extractParameters(initializer, sourceFile),
      returnType: extractReturnType(initializer, sourceFile),
    });

    if (exported) {
      exports.push({ name, isDefault: false, line });
    }
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function extractImport(node: ts.ImportDeclaration, sourceFile: ts.SourceFile, imports: ImportEntry[]): void {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    return;
  }
  const source = node.moduleSpecifier.text;
  const { line } = getStartPosition(node, sourceFile);
  const importClause = node.importClause;

  if (!importClause) {
    // Side-effect only import, e.g. `import './styles.css';`
    imports.push({ source, specifiers: [], isDefault: false, line });
    return;
  }

  if (importClause.name) {
    // Default import: `import Foo from 'x';`
    imports.push({ source, specifiers: [importClause.name.text], isDefault: true, line });
  }

  const bindings = importClause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    // Namespace import: `import * as Foo from 'x';`
    imports.push({ source, specifiers: [bindings.name.text], isDefault: false, line });
  } else if (bindings && ts.isNamedImports(bindings)) {
    // Named imports: `import { Foo, Bar as Baz } from 'x';`
    const specifiers = bindings.elements.map((el) => el.name.text);
    imports.push({ source, specifiers, isDefault: false, line });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function extractNamedExportDeclaration(
  node: ts.ExportDeclaration,
  sourceFile: ts.SourceFile,
  exports: ExportEntry[],
): void {
  const { line } = getStartPosition(node, sourceFile);
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    for (const element of clause.elements) {
      exports.push({ name: element.name.text, isDefault: false, line });
    }
  }
}

function extractExportAssignment(node: ts.ExportAssignment, sourceFile: ts.SourceFile, exports: ExportEntry[]): void {
  if (node.isExportEquals) {
    // `export = foo;` (CommonJS-style) — not a standard ES default export.
    return;
  }
  const { line } = getStartPosition(node, sourceFile);
  const name = ts.isIdentifier(node.expression) ? node.expression.text : 'default';
  exports.push({ name, isDefault: true, line });
}

// ---------------------------------------------------------------------------
// Endpoints (Express/Node.js-style route registration)
// ---------------------------------------------------------------------------

function extractEndpointCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  endpoints: EndpointEntry[],
  symbols: SymbolEntry[],
): void {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return;
  }

  const methodName = callee.name.text.toLowerCase();
  if (!HTTP_VERB_METHODS.has(methodName)) {
    return;
  }

  if (!ts.isIdentifier(callee.expression) || !ROUTER_RECEIVER_PATTERN.test(callee.expression.text)) {
    return;
  }

  const [routeArg] = node.arguments;
  if (!routeArg || !ts.isStringLiteral(routeArg)) {
    return;
  }

  const { line, column } = getStartPosition(node, sourceFile);
  const route = routeArg.text;
  const method = methodName.toUpperCase() as HttpMethod;

  endpoints.push({
    route,
    method,
    filePath,
    line,
    parameters: [], // deeper param/body/response extraction is done by backend-extractor (task 8.1)
  });

  symbols.push({
    id: makeSymbolId(filePath, `${method} ${route}`, line),
    name: `${method} ${route}`,
    type: 'endpoint',
    filePath,
    line,
    column,
    endLine: getEndLine(node, sourceFile),
  });
}
