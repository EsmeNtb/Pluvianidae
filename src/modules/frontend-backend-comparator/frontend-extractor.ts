/**
 * AST-based frontend HTTP call extraction for the Comparador
 * Frontend-Backend module.
 *
 * Uses the TypeScript compiler API (`typescript` package) — consistent with
 * `modules/indexer/symbol-extractor.ts` and `backend-extractor.ts` — to parse
 * a single frontend source file's text and extract every HTTP call it makes,
 * so the comparison engine (task 8.3) can later match these against backend
 * endpoints (task 8.1).
 *
 * Detected call styles:
 *
 *   - `fetch(url, options)` — url from the first argument (string literal or
 *     template literal), method from `options.method` (defaults to `'GET'`,
 *     matching fetch's actual runtime default), and a best-effort
 *     `sentDataType` inferred from `options.body` when it is
 *     `JSON.stringify(<object literal>)`.
 *   - `axios.get/post/put/delete/patch(url, data?, config?)` — method taken
 *     directly from the property name, url from the first argument, and
 *     `sentDataType` from the second argument for post/put/patch when it is
 *     an object literal.
 *   - `axios(config)` — url/method/data read from the config object literal
 *     (method defaults to `'GET'`, matching axios's own default).
 *   - Custom data-fetching hooks (functions matching `/^use[A-Z]/` that
 *     aren't well-known React hooks) — see "Known limitations" below.
 *
 * Known limitations (documented per task 8.2 guidance):
 *
 *   Custom hook *call sites* alone (e.g. `useUsers()`) carry no URL/method
 *   information — that information lives inside the hook's own
 *   implementation, which may be defined in a different file entirely.
 *   Resolving into another file's AST is out of scope for this extractor
 *   (it operates on a single file's source text at a time). As a low-effort
 *   nice-to-have, when a custom hook is *defined* in the same file being
 *   analyzed, this extractor walks into the hook's body and attributes any
 *   fetch/axios calls found inside it to the hook's own definition location
 *   (see `extractCustomHookDeclaration`). Calls to hooks defined elsewhere
 *   are simply skipped — no `FrontendApiCall` is produced for them, and no
 *   error is raised.
 *
 * Environment variable URL patterns: URLs built from `process.env.XXX` or
 * `import.meta.env.XXX` (Vite-style) references are preserved as-authored in
 * the extracted `url` string (e.g. a template literal
 * `` `${process.env.API_URL}/users` `` is recorded as the literal text
 * `${process.env.API_URL}/users`). This keeps the literal path suffix
 * (`/users`) intact for later comparison against backend routes. Stripping
 * or normalizing the env-var prefix for matching purposes is the
 * responsibility of the comparison engine (task 8.3), not this extractor —
 * this extractor's job is only to make sure that information survives
 * extraction.
 *
 * See design.md > "7. Comparador Frontend-Backend" and requirements.md >
 * Requirement 5.2.
 */

import * as path from 'path';
import * as ts from 'typescript';
import { HttpMethod, TypeSchema } from '../../core/models';

export interface FrontendApiCall {
  url: string;
  method: HttpMethod;
  filePath: string;
  line: number;
  /** Best-effort inferred shape of the request body/payload, if any. */
  sentDataType?: TypeSchema;
}

export interface IFrontendExtractor {
  /**
   * Parses `sourceText` (the contents of the file at `filePath`) and
   * extracts every frontend HTTP call (fetch, axios, same-file custom hook)
   * it contains.
   */
  extractApiCalls(filePath: string, sourceText: string): FrontendApiCall[];
}

/** axios.<method>(...) property names recognized as HTTP verb shorthands. */
const AXIOS_VERB_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'delete', 'patch']);

/**
 * Well-known built-in React hooks. Calls to functions matching `/^use[A-Z]/`
 * that are NOT in this list are treated as candidate custom data-fetching
 * hooks (e.g. `useUsers`, `useFetchData`, `useApiQuery`).
 */
const BUILTIN_REACT_HOOKS: ReadonlySet<string> = new Set([
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
  'useContext',
  'useReducer',
  'useLayoutEffect',
  'useImperativeHandle',
  'useDebugValue',
  'useId',
  'useTransition',
  'useDeferredValue',
  'useSyncExternalStore',
  'useInsertionEffect',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class FrontendExtractor implements IFrontendExtractor {
  extractApiCalls(filePath: string, sourceText: string): FrontendApiCall[] {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      getScriptKind(filePath),
    );

    const calls: FrontendApiCall[] = [];

    // Same-file custom hook definitions: name -> body node, so that calls to
    // `useSomething()` elsewhere in the file (but defined here) can be
    // resolved to their body and walked for fetch/axios calls.
    const customHookBodies = new Map<string, ts.Node>();
    collectCustomHookDeclarations(sourceFile, customHookBodies);

    // Directly analyze every custom hook body found in this file — this
    // attributes any fetch/axios calls found inside to the hook's own
    // definition location, regardless of whether/where it's called.
    for (const body of customHookBodies.values()) {
      const visit = (node: ts.Node): void => {
        tryExtractCall(node, sourceFile, filePath, calls);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(body, visit);
    }

    // Walk the whole file for fetch/axios calls that are NOT inside a
    // same-file custom hook body (those were already handled above and
    // attributed to the hook's own definition location instead).
    const visitedCallNodes = new Set<ts.Node>();
    const visitTopLevel = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && !isInsideAnyCustomHookBody(node, customHookBodies)) {
        tryExtractCall(node, sourceFile, filePath, calls, visitedCallNodes);
      }
      ts.forEachChild(node, visitTopLevel);
    };
    ts.forEachChild(sourceFile, visitTopLevel);

    return calls;
  }
}

/** Convenience function form, for callers that don't need a class instance. */
export function extractFrontendApiCalls(filePath: string, sourceText: string): FrontendApiCall[] {
  return new FrontendExtractor().extractApiCalls(filePath, sourceText);
}

// ---------------------------------------------------------------------------
// Script kind detection (mirrors symbol-extractor.ts)
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

/** 1-indexed line of `node`'s start position. */
function getStartLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

// ---------------------------------------------------------------------------
// Custom hook discovery (same-file nice-to-have)
// ---------------------------------------------------------------------------

/** Name is a candidate custom data-fetching hook: `use[A-Z]...` and not a well-known built-in hook. */
function isCustomHookName(name: string): boolean {
  return /^use[A-Z]/.test(name) && !BUILTIN_REACT_HOOKS.has(name);
}

/**
 * Finds function declarations and `const x = (...) => {}` / `const x =
 * function () {}` assignments whose name looks like a custom hook, and
 * records their body node so fetch/axios calls inside can be attributed to
 * the hook's definition.
 */
function collectCustomHookDeclarations(sourceFile: ts.SourceFile, out: Map<string, ts.Node>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && isCustomHookName(node.name.text) && node.body) {
      out.set(node.name.text, node.body);
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          isCustomHookName(decl.name.text) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          out.set(decl.name.text, decl.initializer.body);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

function isInsideAnyCustomHookBody(node: ts.Node, hookBodies: Map<string, ts.Node>): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    for (const body of hookBodies.values()) {
      if (current === body) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Call dispatch
// ---------------------------------------------------------------------------

function tryExtractCall(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  calls: FrontendApiCall[],
  visited?: Set<ts.Node>,
): void {
  if (!ts.isCallExpression(node)) {
    return;
  }
  if (visited?.has(node)) {
    return;
  }

  const fetchCall = tryExtractFetchCall(node, sourceFile, filePath);
  if (fetchCall) {
    calls.push(fetchCall);
    visited?.add(node);
    return;
  }

  const axiosCall = tryExtractAxiosVerbCall(node, sourceFile, filePath) ?? tryExtractAxiosConfigCall(node, sourceFile, filePath);
  if (axiosCall) {
    calls.push(axiosCall);
    visited?.add(node);
  }
}

// ---------------------------------------------------------------------------
// fetch(url, options)
// ---------------------------------------------------------------------------

function tryExtractFetchCall(node: ts.CallExpression, sourceFile: ts.SourceFile, filePath: string): FrontendApiCall | undefined {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'fetch') {
    return undefined;
  }

  const [urlArg, optionsArg] = node.arguments;
  const url = urlArg ? extractUrlText(urlArg) : undefined;
  if (url === undefined) {
    return undefined;
  }

  let method: HttpMethod = 'GET';
  let sentDataType: TypeSchema | undefined;

  if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
    const methodProp = findObjectProperty(optionsArg, 'method');
    if (methodProp && ts.isStringLiteralLike(methodProp)) {
      method = methodProp.text.toUpperCase() as HttpMethod;
    }

    const bodyProp = findObjectProperty(optionsArg, 'body');
    if (bodyProp) {
      sentDataType = inferSentDataTypeFromBodyExpression(bodyProp);
    }
  }

  return {
    url,
    method,
    filePath,
    line: getStartLine(node, sourceFile),
    sentDataType,
  };
}

// ---------------------------------------------------------------------------
// axios.get/post/put/delete/patch(url, data?, config?)
// ---------------------------------------------------------------------------

function tryExtractAxiosVerbCall(node: ts.CallExpression, sourceFile: ts.SourceFile, filePath: string): FrontendApiCall | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'axios') {
    return undefined;
  }

  const methodName = callee.name.text.toLowerCase();
  if (!AXIOS_VERB_METHODS.has(methodName)) {
    return undefined;
  }

  const [urlArg, dataArg] = node.arguments;
  const url = urlArg ? extractUrlText(urlArg) : undefined;
  if (url === undefined) {
    return undefined;
  }

  const method = methodName.toUpperCase() as HttpMethod;
  let sentDataType: TypeSchema | undefined;
  if (dataArg && (methodName === 'post' || methodName === 'put' || methodName === 'patch') && ts.isObjectLiteralExpression(dataArg)) {
    sentDataType = inferTypeSchemaFromObjectLiteral(dataArg);
  }

  return {
    url,
    method,
    filePath,
    line: getStartLine(node, sourceFile),
    sentDataType,
  };
}

// ---------------------------------------------------------------------------
// axios(config)
// ---------------------------------------------------------------------------

function tryExtractAxiosConfigCall(node: ts.CallExpression, sourceFile: ts.SourceFile, filePath: string): FrontendApiCall | undefined {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'axios') {
    return undefined;
  }

  const [configArg] = node.arguments;
  if (!configArg || !ts.isObjectLiteralExpression(configArg)) {
    return undefined;
  }

  const urlProp = findObjectProperty(configArg, 'url');
  const url = urlProp ? extractUrlText(urlProp) : undefined;
  if (url === undefined) {
    return undefined;
  }

  let method: HttpMethod = 'GET';
  const methodProp = findObjectProperty(configArg, 'method');
  if (methodProp && ts.isStringLiteralLike(methodProp)) {
    method = methodProp.text.toUpperCase() as HttpMethod;
  }

  let sentDataType: TypeSchema | undefined;
  const dataProp = findObjectProperty(configArg, 'data');
  if (dataProp && ts.isObjectLiteralExpression(dataProp)) {
    sentDataType = inferTypeSchemaFromObjectLiteral(dataProp);
  }

  return {
    url,
    method,
    filePath,
    line: getStartLine(node, sourceFile),
    sentDataType,
  };
}

// ---------------------------------------------------------------------------
// URL extraction (string literal, template literal, env-var-derived)
// ---------------------------------------------------------------------------

/**
 * Extracts the raw, as-authored text of a URL expression. Supports:
 *   - String literals: `'/api/users'` -> `/api/users`
 *   - Template literals: `` `${API_BASE}/users` `` -> `${API_BASE}/users`
 *     (placeholders, including `process.env.X` / `import.meta.env.X`
 *     references, are preserved verbatim as `${...}` so the literal path
 *     suffix remains intact for later comparison).
 *
 * Returns `undefined` for expressions this extractor can't meaningfully
 * turn into a comparable URL string (e.g. a bare identifier holding a URL
 * built elsewhere) — that's a known limitation for this MVP heuristic.
 */
function extractUrlText(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(expr)) {
    return expr.text;
  }
  if (ts.isTemplateExpression(expr)) {
    return expr.getText().slice(1, -1); // strip surrounding backticks, keep ${...} placeholders as-authored
  }
  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sent data type inference
// ---------------------------------------------------------------------------

/**
 * `fetch`'s `options.body` is often `JSON.stringify(<object literal>)`.
 * When that pattern is recognized, infers a `TypeSchema` from the object
 * literal's own properties. Any other shape (a bare identifier, a
 * `FormData` instance, a raw string, etc.) is left as `undefined` —
 * best-effort only, per task guidance.
 */
function inferSentDataTypeFromBodyExpression(expr: ts.Expression): TypeSchema | undefined {
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === 'JSON' &&
    expr.expression.name.text === 'stringify'
  ) {
    const [objArg] = expr.arguments;
    if (objArg && ts.isObjectLiteralExpression(objArg)) {
      return inferTypeSchemaFromObjectLiteral(objArg);
    }
  }
  return undefined;
}

/** Builds a best-effort `TypeSchema` from an object literal's own properties. */
function inferTypeSchemaFromObjectLiteral(obj: ts.ObjectLiteralExpression): TypeSchema {
  const properties: Record<string, TypeSchema> = {};
  const required: string[] = [];

  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      const propName = prop.name.text;
      properties[propName] = { type: inferLiteralType(prop.initializer) };
      required.push(propName);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const propName = prop.name.text;
      properties[propName] = { type: 'unknown' };
      required.push(propName);
    }
  }

  return { type: 'object', properties, required };
}

/** Best-effort primitive type name for a value expression. */
function inferLiteralType(expr: ts.Expression): string {
  if (ts.isStringLiteralLike(expr)) {
    return 'string';
  }
  if (ts.isNumericLiteral(expr)) {
    return 'number';
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return 'array';
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return 'object';
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return 'null';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Object literal property lookup helper
// ---------------------------------------------------------------------------

/** Finds `key: <expr>` in an object literal and returns `<expr>`, if present. */
function findObjectProperty(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === key) || (ts.isStringLiteral(prop.name) && prop.name.text === key))
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}
