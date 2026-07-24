/**
 * Comparison engine for the Comparador Frontend-Backend module.
 *
 * Wires together `BackendExtractor` (task 8.1) and `FrontendExtractor`
 * (task 8.2): for every indexed file it runs BOTH extractors (a file could
 * in principle contain either backend or frontend code — running both and
 * letting the empty-result case naturally handle non-matching files avoids
 * needing file-path heuristics to decide "is this a backend file"), then
 * matches the resulting backend endpoints against frontend HTTP calls to
 * produce a `FBComparisonReport`.
 *
 * See design.md > "7. Comparador Frontend-Backend" and requirements.md >
 * Requirement 5 (5.3, 5.4, 5.5, 5.6, 5.7).
 *
 * ## Division of responsibility between the four report categories
 *
 * design.md defines `unconsumedEndpoints`, `missingEndpoints`,
 * `typeIncompatibilities` and `discrepancies` as independent lists, but
 * doesn't spell out how they interact when a frontend call and a backend
 * endpoint are *related* (same route) but not a clean match (different
 * method, or a body-schema mismatch). This module resolves that ambiguity
 * with the following documented policy:
 *
 *   - A backend endpoint and frontend call are considered a **matched
 *     pair** only when both their route (per `routesMatch`, below) AND
 *     their HTTP method are equal.
 *   - If an endpoint's route matches at least one frontend call, but never
 *     on the correct method, it is treated as "being called, just
 *     incorrectly" rather than fully unconsumed: each such call produces a
 *     `Discrepancy{category:'method-mismatch'}` (referencing both
 *     locations) instead of the endpoint being reported as unconsumed AND
 *     instead of the call being reported as missing. Only when an
 *     endpoint's route has **no** matching frontend call at all (under any
 *     method) is it reported as `UnconsumedEndpoint`. Symmetrically, a
 *     frontend call is only reported as `MissingEndpoint` when its route
 *     has no matching backend endpoint at all (under any method).
 *   - For matched pairs whose method sends a body (POST/PUT/PATCH), the
 *     body schemas are compared shallowly (top-level property names and
 *     each property's `type` string only — not deep nested-schema diffing,
 *     since both schemas are already best-effort inferred by the
 *     extractors):
 *       - A property present in the backend's expected schema but entirely
 *         **absent** from what the frontend sends is a genuinely missing
 *         field → `Discrepancy{category:'missing-field'}`.
 *       - A property present in **both** schemas whose `type` strings
 *         **differ** is a type mismatch, not an absence → rolled up into a
 *         single `TypeIncompatibility` for the pair (not a `Discrepancy`).
 *   - `route-mismatch` is populated as a best-effort "near miss" heuristic:
 *     when a frontend call has no matching backend endpoint at all (i.e.
 *     it's about to be reported as `MissingEndpoint`), this module also
 *     checks whether some backend route is a *close* textual match (small
 *     Levenshtein edit distance on the param-normalized path) — e.g.
 *     `/user/123` vs. a backend route `/users/:id`. When found, an
 *     additional `Discrepancy{category:'route-mismatch'}` is emitted
 *     alongside the `MissingEndpoint` entry (the call genuinely has no
 *     endpoint, so `MissingEndpoint` is still correct; `route-mismatch`
 *     just adds a hint about *why*). This is intentionally a minimal,
 *     rarely-triggered heuristic for this MVP, not exhaustive route
 *     matching.
 *
 * ## Route matching (`routesMatch`)
 *
 * Backend routes and frontend URLs are compared segment-by-segment after
 * stripping any query string (`?...`):
 *   - A backend segment starting with `:` (Express route param, e.g.
 *     `:id`) matches ANY frontend segment.
 *   - A frontend segment that is a template placeholder in its entirety
 *     (e.g. `${userId}`, as preserved verbatim by `FrontendExtractor`)
 *     matches ANY backend segment — this handles `/users/${userId}`
 *     matching backend route `/users/:id`.
 *   - A leading `${...}` prefix on the frontend URL (an env-var-derived
 *     "host" portion, e.g. `${process.env.API_URL}/users`) is stripped
 *     before splitting into segments, so only the literal path suffix
 *     (`/users`) is compared against the backend route.
 *   - Segment counts must match exactly; otherwise the routes don't match.
 *
 * ## Unanalyzable files (5.7)
 *
 * Mirrors `DeadCodeDetector`'s approach: each file's source is read, then
 * checked for TypeScript parser syntax diagnostics (`parseDiagnostics`, an
 * internal-but-commonly-relied-on field, same technique used there) before
 * running the extractors on it. Any read or syntax failure is caught, the
 * file is pushed to `unanalyzableFiles` with the failure reason, and
 * analysis continues with the remaining files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as ts from 'typescript';
import { EndpointEntry, HttpMethod, SymbolLocation, TypeSchema } from '../../core/models';
import { IIndexer } from '../indexer/index-builder';
import { BackendExtractor, IBackendExtractor } from './backend-extractor';
import { FrontendApiCall, FrontendExtractor, IFrontendExtractor } from './frontend-extractor';

// ---------------------------------------------------------------------------
// Public interface & report shapes (design.md > "7. Comparador
// Frontend-Backend")
// ---------------------------------------------------------------------------

export interface IFrontendBackendComparator {
  analyze(): Promise<FBComparisonReport>;
}

export interface FBComparisonReport {
  unconsumedEndpoints: UnconsumedEndpoint[];
  missingEndpoints: MissingEndpoint[];
  typeIncompatibilities: TypeIncompatibility[];
  discrepancies: Discrepancy[];
  unanalyzableFiles: UnanalyzableFile[];
}

export interface UnconsumedEndpoint {
  route: string;
  method: HttpMethod;
  definitionFile: string;
  definitionLine: number;
}

export interface MissingEndpoint {
  url: string;
  method: HttpMethod;
  callFile: string;
  callLine: number;
}

export interface TypeIncompatibility {
  endpoint: string;
  backendExpected: string;
  frontendSends: string;
  backendLocation: SymbolLocation;
  frontendLocation: SymbolLocation;
}

export interface Discrepancy {
  category: 'method-mismatch' | 'route-mismatch' | 'missing-field';
  sourceFile: string;
  sourceLine: number;
  description: string;
}

/**
 * design.md references `UnanalyzableFile` (e.g. in `FBComparisonReport`)
 * without spelling out its shape in this component's own section — same
 * situation `DeadCodeDetector` documents for its own `UnanalyzableFile`.
 * Defined locally here (rather than imported from `dead-code-detector.ts`)
 * to keep the two modules decoupled; the shape is intentionally identical.
 */
export interface UnanalyzableFile {
  filePath: string;
  reason: string;
}

/** HTTP methods whose calls/endpoints are expected to carry a request body. */
const BODY_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH']);

// ---------------------------------------------------------------------------
// Injectable file reading (mirrors DeadCodeDetector's IFileContentReader)
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
// FrontendBackendComparator
// ---------------------------------------------------------------------------

/**
 * Implements `IFrontendBackendComparator`. Injects `getIndex` only (same
 * narrow dependency pattern as `Searcher`/`DeadCodeDetector`'s
 * constructors) since this module only ever reads the already-built index
 * to discover which files to analyze.
 */
export class FrontendBackendComparator implements IFrontendBackendComparator {
  constructor(
    private readonly indexSource: Pick<IIndexer, 'getIndex'>,
    private readonly backendExtractor: IBackendExtractor = new BackendExtractor(),
    private readonly frontendExtractor: IFrontendExtractor = new FrontendExtractor(),
    private readonly fileReader: IFileContentReader = new FsFileContentReader(),
  ) {}

  async analyze(): Promise<FBComparisonReport> {
    const index = this.indexSource.getIndex();

    const endpoints: EndpointEntry[] = [];
    const calls: FrontendApiCall[] = [];
    const unanalyzableFiles: UnanalyzableFile[] = [];

    for (const filePath of index.files.keys()) {
      try {
        const sourceText = await this.fileReader.readFile(filePath);
        assertParsable(filePath, sourceText);
        endpoints.push(...this.backendExtractor.extractEndpoints(filePath, sourceText));
        calls.push(...this.frontendExtractor.extractApiCalls(filePath, sourceText));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        unanalyzableFiles.push({ filePath, reason });
      }
    }

    return this.compare(endpoints, calls, unanalyzableFiles);
  }

  // -------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------

  private compare(
    endpoints: EndpointEntry[],
    calls: FrontendApiCall[],
    unanalyzableFiles: UnanalyzableFile[],
  ): FBComparisonReport {
    const unconsumedEndpoints: UnconsumedEndpoint[] = [];
    const missingEndpoints: MissingEndpoint[] = [];
    const typeIncompatibilities: TypeIncompatibility[] = [];
    const discrepancies: Discrepancy[] = [];

    // Calls accounted for either by a full route+method match, or by a
    // method-mismatch discrepancy (route matches, method doesn't) —
    // either way they must NOT also be reported as "missing".
    const accountedForCallIndices = new Set<number>();

    for (const endpoint of endpoints) {
      const routeMatchedCalls: Array<{ call: FrontendApiCall; index: number }> = [];
      calls.forEach((call, index) => {
        if (routesMatch(endpoint.route, call.url)) {
          routeMatchedCalls.push({ call, index });
        }
      });

      const methodMatched = routeMatchedCalls.filter(({ call }) => call.method === endpoint.method);

      if (methodMatched.length > 0) {
        for (const { call, index } of methodMatched) {
          accountedForCallIndices.add(index);
          this.compareSchemas(endpoint, call, typeIncompatibilities, discrepancies);
        }
      } else if (routeMatchedCalls.length > 0) {
        for (const { call, index } of routeMatchedCalls) {
          accountedForCallIndices.add(index);
          discrepancies.push({
            category: 'method-mismatch',
            sourceFile: call.filePath,
            sourceLine: call.line,
            description:
              `El frontend llama a "${call.url}" con método ${call.method}, pero el backend define ` +
              `la ruta "${endpoint.route}" con método ${endpoint.method}.`,
          });
        }
      } else {
        unconsumedEndpoints.push({
          route: endpoint.route,
          method: endpoint.method,
          definitionFile: endpoint.filePath,
          definitionLine: endpoint.line,
        });
      }
    }

    calls.forEach((call, index) => {
      if (accountedForCallIndices.has(index)) {
        return;
      }
      missingEndpoints.push({
        url: call.url,
        method: call.method,
        callFile: call.filePath,
        callLine: call.line,
      });

      const nearMissRoute = findNearMissRoute(call.url, endpoints);
      if (nearMissRoute) {
        discrepancies.push({
          category: 'route-mismatch',
          sourceFile: call.filePath,
          sourceLine: call.line,
          description:
            `El frontend llama a "${call.url}", que no coincide con ninguna ruta del backend, pero es ` +
            `muy similar a la ruta definida "${nearMissRoute.route}" (${nearMissRoute.method}). ` +
            `Verifica si se trata de un error de tipeo.`,
        });
      }
    });

    return { unconsumedEndpoints, missingEndpoints, typeIncompatibilities, discrepancies, unanalyzableFiles };
  }

  /**
   * Shallow body-schema comparison for a matched (route+method) pair.
   * Only applies to methods that send a body (POST/PUT/PATCH) and only
   * when both sides have a schema to compare — see the class-level doc
   * comment's "Division of responsibility" section for how the result is
   * split between `TypeIncompatibility` (type mismatches on shared
   * properties) and `Discrepancy{category:'missing-field'}` (required
   * backend properties entirely absent from the frontend's sent data).
   */
  private compareSchemas(
    endpoint: EndpointEntry,
    call: FrontendApiCall,
    typeIncompatibilities: TypeIncompatibility[],
    discrepancies: Discrepancy[],
  ): void {
    if (!BODY_METHODS.has(endpoint.method)) {
      return;
    }

    const backendSchema = endpoint.bodySchema;
    const frontendSchema = call.sentDataType;
    if (!backendSchema || !frontendSchema) {
      return;
    }

    const backendProps = backendSchema.properties ?? {};
    const frontendProps = frontendSchema.properties ?? {};
    const requiredBackend = backendSchema.required ?? [];

    const backendLocation: SymbolLocation = { filePath: endpoint.filePath, line: endpoint.line, column: 0 };
    const frontendLocation: SymbolLocation = { filePath: call.filePath, line: call.line, column: 0 };

    for (const field of requiredBackend) {
      if (!(field in frontendProps)) {
        discrepancies.push({
          category: 'missing-field',
          sourceFile: call.filePath,
          sourceLine: call.line,
          description:
            `El backend espera el campo requerido "${field}" en ${endpoint.method} ${endpoint.route}, ` +
            `pero el frontend no lo envía en la llamada.`,
        });
      }
    }

    // `'any'`/`'unknown'` are the extractors' own sentinels for "no static
    // type information available" (see backend-extractor.ts's body schema
    // heuristic and frontend-extractor.ts's shorthand-property heuristic) —
    // not a real type constraint. Treating either side as a wildcard here
    // avoids flagging a mismatch on every matched pair purely because the
    // backend's best-effort body inference can't determine a concrete type.
    const isWildcard = (type: string): boolean => type === 'any' || type === 'unknown';
    const mismatchedTypeFields = Object.keys(backendProps).filter(
      (field) =>
        field in frontendProps &&
        !isWildcard(backendProps[field].type) &&
        !isWildcard(frontendProps[field].type) &&
        backendProps[field].type !== frontendProps[field].type,
    );

    if (mismatchedTypeFields.length > 0) {
      typeIncompatibilities.push({
        endpoint: `${endpoint.method} ${endpoint.route}`,
        backendExpected: renderSchema(backendSchema),
        frontendSends: renderSchema(frontendSchema),
        backendLocation,
        frontendLocation,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

const ENV_PREFIX_PATTERN = /^\$\{[^}]*\}/;
const TEMPLATE_PLACEHOLDER_PATTERN = /^\$\{.*\}$/;

function stripQueryString(value: string): string {
  const qIndex = value.indexOf('?');
  return qIndex === -1 ? value : value.slice(0, qIndex);
}

/** Strips a leading `${...}` env-var-derived "host" prefix, if present. */
function stripEnvPrefix(url: string): string {
  return url.replace(ENV_PREFIX_PATTERN, '');
}

function pathSegments(value: string): string[] {
  return value.split('/').filter((segment) => segment.length > 0);
}

/** See the module-level doc comment's "Route matching" section. */
export function routesMatch(backendRoute: string, frontendUrl: string): boolean {
  const backendSegments = pathSegments(stripQueryString(backendRoute));
  const frontendSegments = pathSegments(stripQueryString(stripEnvPrefix(frontendUrl)));

  if (backendSegments.length !== frontendSegments.length) {
    return false;
  }

  for (let i = 0; i < backendSegments.length; i++) {
    const backendSegment = backendSegments[i];
    const frontendSegment = frontendSegments[i];

    if (backendSegment.startsWith(':')) {
      continue;
    }
    if (TEMPLATE_PLACEHOLDER_PATTERN.test(frontendSegment)) {
      continue;
    }
    if (backendSegment !== frontendSegment) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// route-mismatch near-miss heuristic
// ---------------------------------------------------------------------------

/** Small, allocation-light Levenshtein edit distance. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) {
    dp[i][0] = i;
  }
  for (let j = 0; j < cols; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[rows - 1][cols - 1];
}

/** Normalizes a backend route for near-miss comparison by collapsing every `:param` segment to `*`. */
function normalizeRouteForNearMiss(route: string): string {
  return pathSegments(stripQueryString(route))
    .map((segment) => (segment.startsWith(':') ? '*' : segment))
    .join('/');
}

/** Normalizes a frontend URL for near-miss comparison the same way, collapsing `${...}` segments to `*`. */
function normalizeUrlForNearMiss(url: string): string {
  return pathSegments(stripQueryString(stripEnvPrefix(url)))
    .map((segment) => (TEMPLATE_PLACEHOLDER_PATTERN.test(segment) ? '*' : segment))
    .join('/');
}

/**
 * Best-effort "near miss" lookup for `Discrepancy{category:'route-mismatch'}`
 * (see the module-level doc comment). Only considered a near miss when the
 * normalized paths are close (edit distance <= 2) but NOT identical (an
 * identical normalized path would already have been caught by
 * `routesMatch`) and both paths are non-trivial (length >= 3), to avoid
 * noisy matches on very short paths.
 */
function findNearMissRoute(callUrl: string, endpoints: EndpointEntry[]): EndpointEntry | undefined {
  const normalizedCall = normalizeUrlForNearMiss(callUrl);
  if (normalizedCall.length < 3) {
    return undefined;
  }

  let best: { endpoint: EndpointEntry; distance: number } | undefined;

  for (const endpoint of endpoints) {
    const normalizedRoute = normalizeRouteForNearMiss(endpoint.route);
    if (normalizedRoute.length < 3 || normalizedRoute === normalizedCall) {
      continue;
    }

    const distance = levenshteinDistance(normalizedCall, normalizedRoute);
    if (distance > 0 && distance <= 2 && (!best || distance < best.distance)) {
      best = { endpoint, distance };
    }
  }

  return best?.endpoint;
}

// ---------------------------------------------------------------------------
// Schema rendering (for TypeIncompatibility's human-readable summaries)
// ---------------------------------------------------------------------------

function renderSchema(schema: TypeSchema): string {
  if (schema.type !== 'object' || !schema.properties) {
    return schema.type;
  }
  const propsText = Object.entries(schema.properties)
    .map(([name, propSchema]) => `${name}: ${propSchema.type}`)
    .join(', ');
  return `{ ${propsText} }`;
}

// ---------------------------------------------------------------------------
// Syntax-error detection (mirrors DeadCodeDetector's parseSourceOrThrow)
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
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * Parses `sourceText` and throws a descriptive error if the TypeScript
 * parser recorded syntax diagnostics, so `analyze()` can register the file
 * as unanalyzable (requirements.md 5.7) instead of silently running the
 * extractors against a partially-recovered AST.
 */
function assertParsable(filePath: string, sourceText: string): void {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    getScriptKind(filePath),
  );

  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    const message = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ');
    throw new Error(`Error de sintaxis: ${message}`);
  }
}
