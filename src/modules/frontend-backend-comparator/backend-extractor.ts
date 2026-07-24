/**
 * Backend endpoint extraction for the Comparador Frontend-Backend module.
 *
 * `symbol-extractor.ts` (task 2.2) already performs a *lightweight* pass
 * over Express/Node.js route registrations while building the repository
 * index — it records route, method and location but deliberately leaves
 * `parameters` empty and omits `bodySchema`/`responseSchema` (see the
 * comment on `extractEndpointCall` there).
 *
 * This module performs the deeper, standalone extraction the Comparador
 * needs: for every `app.get/post/put/delete/patch(...)` / `router.<verb>(...)`
 * call it extracts route params, query params, body schema and response
 * schema by statically analyzing the route handler's body, using the
 * TypeScript compiler API (consistent with the rest of the codebase).
 *
 * See design.md > "7. Comparador Frontend-Backend" and > "Data Models"
 * (`EndpointEntry`, `ParameterInfo`, `TypeSchema`), and requirements.md >
 * Requirement 5.1.
 *
 * ## Heuristics and known limitations
 *
 * Because Express is untyped at runtime, all inference here is best-effort
 * static analysis, not a guarantee of the real runtime shape:
 *
 *   - **Route params** (`/users/:id`): always extracted as
 *     `{ type: 'string', required: true, source: 'params' }` — Express
 *     route params are always strings and always present when the route
 *     matches.
 *   - **Query params** (`req.query.foo` / `req.query['foo']`): extracted as
 *     `{ type: 'string', required: false, source: 'query' }` — Express
 *     doesn't type or require query params.
 *   - **Body schema**: destructuring (`const { a, b } = req.body`) or
 *     direct property access (`req.body.a`) is collected into
 *     `{ type: 'object', properties: {...}, required: [...] }`. When
 *     `req.body` is used as a whole (passed to another function, assigned
 *     without destructuring, etc.) without any further property access
 *     being found, a generic `{ type: 'object' }` is produced instead.
 *     Property types default to `'any'` since there's no static type
 *     information available for a destructured/accessed body property.
 *   - **Response schema**: the first `res.json(...)` / `res.send(...)` /
 *     `res.status(...).json(...)` call found in the handler is used. If its
 *     argument is an object literal, properties are inferred from literal
 *     values (string/number/boolean/array/nested object); non-literal
 *     values (e.g. `user.id`) default to `'any'`. If the argument isn't an
 *     object literal at all (e.g. `res.json(user)`), a generic
 *     `{ type: 'object' }` is produced. Only the first matching call is
 *     used — later, alternative response shapes in other branches are not
 *     merged.
 *   - **Named handler references** (`app.get('/x', myHandler)`): resolved
 *     to a function declaration or `const`/arrow-function assignment within
 *     the *same file* to analyze its body. Handlers imported from another
 *     file are out of scope for this task — route/method/route-params are
 *     still recorded, but query/body/response extraction is skipped for
 *     that endpoint.
 *   - Only the **last** argument to the route-registration call is treated
 *     as the handler (middleware functions preceding it are ignored), since
 *     the terminal handler is what typically produces the response.
 */

import * as path from 'path';
import * as ts from 'typescript';
import { EndpointEntry, HttpMethod, ParameterInfo, TypeSchema } from '../../core/models';

export interface IBackendExtractor {
  /**
   * Parses `sourceText` (the contents of the file at `filePath`) and
   * extracts every Express/Node.js-style route registration it finds, with
   * route params, query params, body schema and response schema populated
   * on a best-effort basis (see module-level doc comment for heuristics).
   */
  extractEndpoints(filePath: string, sourceText: string): EndpointEntry[];
}

/** HTTP verb method names recognized as Express/Node.js route handlers. */
const HTTP_VERB_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'delete', 'patch']);

/**
 * Identifier names for the "app"/"router" receiver object in an endpoint
 * call expression (e.g. `app.get(...)`, `router.post(...)`). Mirrors the
 * pattern used in `indexer/symbol-extractor.ts` for consistency.
 */
const ROUTER_RECEIVER_PATTERN = /router|app|route/i;

/** A function declaration, function expression, or arrow function. */
type FunctionLikeNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class BackendExtractor implements IBackendExtractor {
  extractEndpoints(filePath: string, sourceText: string): EndpointEntry[] {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      getScriptKind(filePath),
    );

    const endpoints: EndpointEntry[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const endpoint = tryExtractEndpoint(node, sourceFile, filePath);
        if (endpoint) {
          endpoints.push(endpoint);
        }
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    return endpoints;
  }
}

/** Convenience function form, for callers that don't need a class instance. */
export function extractBackendEndpoints(filePath: string, sourceText: string): EndpointEntry[] {
  return new BackendExtractor().extractEndpoints(filePath, sourceText);
}

// ---------------------------------------------------------------------------
// Script kind detection (mirrors indexer/symbol-extractor.ts)
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
      return ts.ScriptKind.JSX; // allow JSX syntax in .js files (common in React/Node codebases)
    default:
      return ts.ScriptKind.Unknown;
  }
}

function getStartPosition(node: ts.Node, sourceFile: ts.SourceFile): { line: number } {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1 };
}

// ---------------------------------------------------------------------------
// Endpoint detection
// ---------------------------------------------------------------------------

function tryExtractEndpoint(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
): EndpointEntry | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const methodName = callee.name.text.toLowerCase();
  if (!HTTP_VERB_METHODS.has(methodName)) {
    return undefined;
  }

  if (!ts.isIdentifier(callee.expression) || !ROUTER_RECEIVER_PATTERN.test(callee.expression.text)) {
    return undefined;
  }

  const [routeArg, ...handlerArgs] = node.arguments;
  if (!routeArg || !ts.isStringLiteral(routeArg)) {
    return undefined;
  }

  const route = routeArg.text;
  const method = methodName.toUpperCase() as HttpMethod;
  const { line } = getStartPosition(node, sourceFile);

  const parameters: ParameterInfo[] = extractRouteParams(route);

  const handlerFn = resolveHandler(sourceFile, handlerArgs);

  let bodySchema: TypeSchema | undefined;
  let responseSchema: TypeSchema | undefined;

  if (handlerFn) {
    const body = handlerFn.body;
    if (body) {
      const reqParamName = getParamName(handlerFn, 0) ?? 'req';
      const resParamName = getParamName(handlerFn, 1) ?? 'res';
      parameters.push(...collectQueryParams(body, reqParamName));
      bodySchema = extractBodySchema(body, reqParamName);
      responseSchema = extractResponseSchema(body, resParamName);
    }
  }

  return { route, method, filePath, line, parameters, bodySchema, responseSchema };
}

/**
 * Resolves the actual route handler from the arguments following the route
 * path. Only the last argument is considered the terminal handler —
 * preceding arguments are treated as middleware and ignored (see
 * module-level doc comment).
 */
function resolveHandler(
  sourceFile: ts.SourceFile,
  handlerArgs: ts.Expression[],
): FunctionLikeNode | undefined {
  const lastHandlerArg = handlerArgs[handlerArgs.length - 1];
  if (!lastHandlerArg) {
    return undefined;
  }

  if (ts.isArrowFunction(lastHandlerArg) || ts.isFunctionExpression(lastHandlerArg)) {
    return lastHandlerArg;
  }

  if (ts.isIdentifier(lastHandlerArg)) {
    return resolveNamedHandler(sourceFile, lastHandlerArg.text);
  }

  return undefined;
}

/**
 * Looks for a function declaration or `const`/`let`/`var` assignment of a
 * function/arrow expression named `name` within `sourceFile`. Returns
 * `undefined` if no such declaration exists in this file (e.g. the handler
 * is imported from elsewhere) — cross-file resolution is out of scope.
 */
function resolveNamedHandler(sourceFile: ts.SourceFile, name: string): FunctionLikeNode | undefined {
  let found: FunctionLikeNode | undefined;

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      found = node.initializer;
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

function getParamName(fn: FunctionLikeNode, index: number): string | undefined {
  const param = fn.parameters[index];
  return param && ts.isIdentifier(param.name) ? param.name.text : undefined;
}

// ---------------------------------------------------------------------------
// Route params (`/users/:id`)
// ---------------------------------------------------------------------------

const ROUTE_PARAM_PATTERN = /:([A-Za-z0-9_]+)/g;

function extractRouteParams(route: string): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  for (const match of route.matchAll(ROUTE_PARAM_PATTERN)) {
    params.push({ name: match[1], type: 'string', required: true, source: 'params' });
  }
  return params;
}

// ---------------------------------------------------------------------------
// Query params (`req.query.foo`, `req.query['foo']`)
// ---------------------------------------------------------------------------

function isPropertyAccessOn(node: ts.Node, objectName: string, propertyName: string): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === objectName &&
    node.name.text === propertyName
  );
}

function collectQueryParams(body: ts.Node, reqParamName: string): ParameterInfo[] {
  const seen = new Set<string>();
  const params: ParameterInfo[] = [];

  const addParam = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      params.push({ name, type: 'string', required: false, source: 'query' });
    }
  };

  const visit = (node: ts.Node): void => {
    if (isPropertyAccessOn(node, reqParamName, 'query')) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        addParam(parent.name.text);
        return;
      }
      if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        ts.isStringLiteralLike(parent.argumentExpression)
      ) {
        addParam(parent.argumentExpression.text);
        return;
      }
      // `req.query` used as a whole (e.g. spread, passed wholesale) — no
      // individual query param names can be determined; nothing to add.
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(body);
  return params;
}

// ---------------------------------------------------------------------------
// Body schema (`req.body`, `const { a, b } = req.body`, `req.body.a`)
// ---------------------------------------------------------------------------

function extractBodySchema(body: ts.Node, reqParamName: string): TypeSchema | undefined {
  const properties: Record<string, TypeSchema> = {};
  const required: string[] = [];
  let sawBodyUsage = false;

  const addProperty = (name: string): void => {
    if (!(name in properties)) {
      properties[name] = { type: 'any' };
      required.push(name);
    }
  };

  const visit = (node: ts.Node): void => {
    if (isPropertyAccessOn(node, reqParamName, 'body')) {
      sawBodyUsage = true;
      const parent = node.parent;

      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        addProperty(parent.name.text);
        return;
      }

      if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        ts.isStringLiteralLike(parent.argumentExpression)
      ) {
        addProperty(parent.argumentExpression.text);
        return;
      }

      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isObjectBindingPattern(parent.name)
      ) {
        for (const element of parent.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            const propertyName =
              element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
                ? element.propertyName.text
                : element.name.text;
            addProperty(propertyName);
          }
        }
        return;
      }

      // `req.body` used as a whole (passed to another function, assigned
      // without destructuring, etc.) — no property-level detail available.
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(body);

  if (!sawBodyUsage) {
    return undefined;
  }
  if (Object.keys(properties).length > 0) {
    return { type: 'object', properties, required };
  }
  return { type: 'object' };
}

// ---------------------------------------------------------------------------
// Response schema (`res.json(...)`, `res.send(...)`, `res.status(...).json(...)`)
// ---------------------------------------------------------------------------

function extractResponseSchema(body: ts.Node, resParamName: string): TypeSchema | undefined {
  let result: TypeSchema | undefined;

  const isResIdentifier = (expr: ts.Expression): boolean => ts.isIdentifier(expr) && expr.text === resParamName;

  const isResStatusCall = (expr: ts.Expression): boolean =>
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    isResIdentifier(expr.expression.expression) &&
    expr.expression.name.text === 'status';

  const visit = (node: ts.Node): void => {
    if (result) {
      return;
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const receiver = node.expression.expression;

      if ((methodName === 'json' || methodName === 'send') && (isResIdentifier(receiver) || isResStatusCall(receiver))) {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          result = schemaFromObjectLiteral(arg);
        } else if (arg) {
          result = { type: 'object' };
        }
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return result;
}

function schemaFromObjectLiteral(obj: ts.ObjectLiteralExpression): TypeSchema {
  const properties: Record<string, TypeSchema> = {};
  const required: string[] = [];

  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      const name = prop.name.text;
      properties[name] = inferSchemaFromExpression(prop.initializer);
      required.push(name);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      properties[name] = { type: 'any' };
      required.push(name);
    }
    // Spread assignments (`...rest`) and computed property names aren't
    // statically resolvable in general — skipped for this MVP heuristic.
  }

  return { type: 'object', properties, required };
}

function inferSchemaFromExpression(expr: ts.Expression): TypeSchema {
  if (ts.isStringLiteralLike(expr)) {
    return { type: 'string' };
  }
  if (ts.isNumericLiteral(expr)) {
    return { type: 'number' };
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { type: 'boolean' };
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return { type: 'array' };
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return schemaFromObjectLiteral(expr);
  }
  // Not statically inferable (property access, call expression, identifier,
  // etc.) — default to 'any' per the module-level heuristic.
  return { type: 'any' };
}
