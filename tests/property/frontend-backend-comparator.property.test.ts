import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { BackendExtractor } from '../../src/modules/frontend-backend-comparator/backend-extractor';

// ---------------------------------------------------------------------------
// Feature: pluvianidae-mvp, Property 12: Backend endpoint extraction
// Validates: Requirements 5.1
//
// *For any* Express/Node.js route definition containing a route path, HTTP
// method, parameters, body schema, and response types, the Comparador SHALL
// extract all these properties correctly with their file locations.
//
// This test synthesizes valid `app.<method>('<route>', (req, res) => {...})`
// source strings from randomly generated route param names, body property
// names, response property name/kind pairs, and a random number of leading
// blank lines (to vary the declaration's line number), then asserts
// `BackendExtractor.extractEndpoints` recovers the method, route, route
// params, body schema, response schema, and line number exactly.
// ---------------------------------------------------------------------------

/**
 * Reserved words that would otherwise be valid matches for the identifier
 * pattern below — excluded because some generated identifiers are used as
 * destructuring binding names (`const { <name> } = req.body`), where a
 * reserved word would be a syntax error.
 */
const RESERVED_WORDS = new Set([
  'do', 'if', 'in', 'for', 'let', 'new', 'try', 'var',
  'case', 'else', 'enum', 'null', 'this', 'true', 'void', 'with',
  'break', 'catch', 'class', 'const', 'false', 'super', 'throw', 'while', 'yield',
  'delete', 'export', 'import', 'public', 'return', 'static', 'switch', 'typeof',
  'default', 'extends', 'finally', 'package',
  'function', 'continue', 'debugger',
]);

const identifierArbitrary = fc
  .stringMatching(/^[a-z][a-z0-9]{2,8}$/)
  .filter((name) => !RESERVED_WORDS.has(name));

const httpMethodArbitrary = fc.constantFrom('get', 'post', 'put', 'delete', 'patch');

const responsePropKindArbitrary = fc.constantFrom<'string' | 'number' | 'boolean'>('string', 'number', 'boolean');

interface ResponsePropSpec {
  name: string;
  kind: 'string' | 'number' | 'boolean';
}

const responsePropArbitrary: fc.Arbitrary<ResponsePropSpec> = fc.record({
  name: identifierArbitrary,
  kind: responsePropKindArbitrary,
});

/** Renders the literal source text for a given response property spec. */
function literalFor(kind: ResponsePropSpec['kind']): string {
  switch (kind) {
    case 'string':
      return "'val'";
    case 'number':
      return '1';
    case 'boolean':
      return 'true';
  }
}

/** Maps a response property kind to the `TypeSchema.type` the extractor should infer for it. */
function expectedSchemaType(kind: ResponsePropSpec['kind']): string {
  return kind;
}

const scenarioArbitrary = fc.record({
  leadingBlankLines: fc.integer({ min: 0, max: 5 }),
  method: httpMethodArbitrary,
  resource: identifierArbitrary,
  routeParamNames: fc.uniqueArray(identifierArbitrary, { minLength: 0, maxLength: 3 }),
  bodyPropNames: fc.uniqueArray(identifierArbitrary, { minLength: 0, maxLength: 3 }),
  responseProps: fc.uniqueArray(responsePropArbitrary, { minLength: 0, maxLength: 3, selector: (p) => p.name }),
});

/** Builds the synthesized Express route source text and the expected line number for the call. */
function buildSource(scenario: {
  leadingBlankLines: number;
  method: string;
  resource: string;
  routeParamNames: string[];
  bodyPropNames: string[];
  responseProps: ResponsePropSpec[];
}): { source: string; route: string; callLine: number } {
  const route = '/' + scenario.resource + scenario.routeParamNames.map((name) => `/:${name}`).join('');

  const lines: string[] = [];
  for (let i = 0; i < scenario.leadingBlankLines; i++) {
    lines.push('');
  }
  const callLine = lines.length + 1;

  lines.push(`app.${scenario.method}('${route}', (req, res) => {`);
  if (scenario.bodyPropNames.length > 0) {
    lines.push(`  const { ${scenario.bodyPropNames.join(', ')} } = req.body;`);
  }
  const responseEntries = scenario.responseProps.map((p) => `${p.name}: ${literalFor(p.kind)}`).join(', ');
  lines.push(`  res.json({ ${responseEntries} });`);
  lines.push('});');

  return { source: lines.join('\n'), route, callLine };
}

describe('BackendExtractor.extractEndpoints property tests', () => {
  // Feature: pluvianidae-mvp, Property 12: Backend endpoint extraction
  // Validates: Requirements 5.1
  it('extracts method, route, route params, body schema, response schema, and line number for a synthesized Express route', () => {
    const extractor = new BackendExtractor();
    const filePath = '/repo/routes.ts';

    fc.assert(
      fc.property(scenarioArbitrary, (scenario) => {
        const { source, route, callLine } = buildSource(scenario);

        const endpoints = extractor.extractEndpoints(filePath, source);

        expect(endpoints).toHaveLength(1);
        const [endpoint] = endpoints;

        expect(endpoint.method).toBe(scenario.method.toUpperCase());
        expect(endpoint.route).toBe(route);
        expect(endpoint.filePath).toBe(filePath);
        expect(endpoint.line).toBe(callLine);

        // Route params: exactly the generated names, each as a required
        // string param sourced from `params`, in declaration order.
        const actualRouteParams = endpoint.parameters.filter((p) => p.source === 'params');
        expect(actualRouteParams).toEqual(
          scenario.routeParamNames.map((name) => ({ name, type: 'string', required: true, source: 'params' })),
        );

        // Body schema: only present when the handler destructures req.body,
        // with every destructured name recorded as an `any`-typed required
        // property, in declaration order.
        if (scenario.bodyPropNames.length > 0) {
          expect(endpoint.bodySchema).toEqual({
            type: 'object',
            properties: Object.fromEntries(scenario.bodyPropNames.map((name) => [name, { type: 'any' }])),
            required: scenario.bodyPropNames,
          });
        } else {
          expect(endpoint.bodySchema).toBeUndefined();
        }

        // Response schema: always present (res.json is always called with
        // an object literal, possibly empty), with each property's type
        // inferred from its literal kind, in declaration order.
        expect(endpoint.responseSchema).toEqual({
          type: 'object',
          properties: Object.fromEntries(
            scenario.responseProps.map((p) => [p.name, { type: expectedSchemaType(p.kind) }]),
          ),
          required: scenario.responseProps.map((p) => p.name),
        });
      }),
      { numRuns: 75 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: pluvianidae-mvp, Property 14: Connection mismatch detection
// Validates: Requirements 5.3, 5.4
//
// *For any* set of backend endpoints and frontend HTTP calls, the Comparador
// SHALL report every endpoint without a matching frontend consumer as
// "unconsumed" and every frontend call without a matching backend endpoint
// as "missing endpoint".
//
// This test constructs `EndpointEntry`/`FrontendApiCall` objects directly
// (bypassing file parsing) by injecting stub `IBackendExtractor` /
// `IFrontendExtractor` / `IFileContentReader` implementations into
// `FrontendBackendComparator`, so only the `compare(...)` matching logic
// (routesMatch-based) is exercised. Routes/URLs are drawn from a small pool
// of literal (param-free, template-free) path strings, so `routesMatch`
// reduces to plain string equality — this isolates the "unconsumed" /
// "missing endpoint" connection-matching property (5.3/5.4) from the
// method-mismatch / type-incompatibility policy (5.5/5.6, covered by 8.7).
// ---------------------------------------------------------------------------

import { FrontendBackendComparator } from '../../src/modules/frontend-backend-comparator/comparator';
import { IBackendExtractor } from '../../src/modules/frontend-backend-comparator/backend-extractor';
import { FrontendApiCall, IFrontendExtractor } from '../../src/modules/frontend-backend-comparator/frontend-extractor';
import { EndpointEntry, FileEntry, HttpMethod, RepositoryIndex } from '../../src/core/models';
import { IIndexer } from '../../src/modules/indexer/index-builder';

const ROUTE_POOL = ['/users', '/orders', '/items', '/products', '/carts'] as const;
const METHOD_POOL: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

interface RouteMethodSpec {
  route: string;
  method: HttpMethod;
}

const routeMethodArbitrary: fc.Arbitrary<RouteMethodSpec> = fc.record({
  route: fc.constantFrom(...ROUTE_POOL),
  method: fc.constantFrom(...METHOD_POOL),
});

function makeFileEntry(filePath: string): FileEntry {
  return {
    path: filePath,
    relativePath: filePath,
    extension: '.ts',
    lastModified: new Date(),
    symbols: [],
    imports: [],
    exports: [],
  };
}

function makeIndexSource(files: string[]): Pick<IIndexer, 'getIndex'> {
  const index: RepositoryIndex = {
    rootPath: '/repo',
    files: new Map(files.map((f) => [f, makeFileEntry(f)])),
    symbols: new Map(),
    importGraph: new Map(),
    exportGraph: new Map(),
    endpoints: [],
    lastUpdated: new Date(),
  };
  return { getIndex: () => index };
}

describe('FrontendBackendComparator.compare property tests', () => {
  // Feature: pluvianidae-mvp, Property 14: Connection mismatch detection
  // Validates: Requirements 5.3, 5.4
  it('reports exactly the endpoints/calls with no same-route counterpart as unconsumed/missing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(routeMethodArbitrary, { maxLength: 6 }),
        fc.array(routeMethodArbitrary, { maxLength: 6 }),
        async (backendSpecs, frontendSpecs) => {
          const backendFilePaths = backendSpecs.map((_, i) => `/repo/backend${i}.ts`);
          const frontendFilePaths = frontendSpecs.map((_, i) => `/repo/frontend${i}.ts`);

          const endpoints: EndpointEntry[] = backendSpecs.map((spec, i) => ({
            route: spec.route,
            method: spec.method,
            filePath: backendFilePaths[i],
            line: i + 1,
            parameters: [],
          }));

          const calls: FrontendApiCall[] = frontendSpecs.map((spec, i) => ({
            url: spec.route,
            method: spec.method,
            filePath: frontendFilePaths[i],
            line: i + 1,
          }));

          const stubBackendExtractor: IBackendExtractor = {
            extractEndpoints(filePath: string): EndpointEntry[] {
              return endpoints.filter((e) => e.filePath === filePath);
            },
          };
          const stubFrontendExtractor: IFrontendExtractor = {
            extractApiCalls(filePath: string): FrontendApiCall[] {
              return calls.filter((c) => c.filePath === filePath);
            },
          };
          const stubFileReader = { readFile: async () => '' };

          const indexSource = makeIndexSource([...backendFilePaths, ...frontendFilePaths]);
          const comparator = new FrontendBackendComparator(
            indexSource,
            stubBackendExtractor,
            stubFrontendExtractor,
            stubFileReader,
          );

          const report = await comparator.analyze();

          // A route (any method) present among frontend call URLs counts as
          // having "a matching frontend consumer" for the connection-level
          // property under test (method-specific fallout is Property 15's
          // concern, not this one).
          const callUrls = new Set(calls.map((c) => c.url));
          const endpointRoutes = new Set(endpoints.map((e) => e.route));

          const expectedUnconsumed = endpoints.filter((e) => !callUrls.has(e.route));
          const expectedMissing = calls.filter((c) => !endpointRoutes.has(c.url));

          expect(report.unconsumedEndpoints).toHaveLength(expectedUnconsumed.length);
          for (const endpoint of expectedUnconsumed) {
            expect(
              report.unconsumedEndpoints.some(
                (u) =>
                  u.route === endpoint.route &&
                  u.method === endpoint.method &&
                  u.definitionFile === endpoint.filePath &&
                  u.definitionLine === endpoint.line,
              ),
            ).toBe(true);
          }
          // No endpoint WITH a same-route call (under any method) is ever
          // reported as unconsumed.
          for (const endpoint of endpoints.filter((e) => callUrls.has(e.route))) {
            expect(
              report.unconsumedEndpoints.some(
                (u) => u.definitionFile === endpoint.filePath && u.definitionLine === endpoint.line,
              ),
            ).toBe(false);
          }

          expect(report.missingEndpoints).toHaveLength(expectedMissing.length);
          for (const call of expectedMissing) {
            expect(
              report.missingEndpoints.some(
                (m) =>
                  m.url === call.url &&
                  m.method === call.method &&
                  m.callFile === call.filePath &&
                  m.callLine === call.line,
              ),
            ).toBe(true);
          }
          // No call WITH a same-route endpoint (under any method) is ever
          // reported as missing.
          for (const call of calls.filter((c) => endpointRoutes.has(c.url))) {
            expect(
              report.missingEndpoints.some(
                (m) => m.callFile === call.filePath && m.callLine === call.line,
              ),
            ).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: pluvianidae-mvp, Property 13: Frontend API call extraction
// Validates: Requirements 5.2
//
// *For any* frontend code containing HTTP calls (fetch, axios, custom
// hooks), the Comparador SHALL identify the URL, HTTP method, sent data
// types, and file location of each call.
//
// This test synthesizes fetch()/axios verb/axios(config) call source text
// from arbitrary URLs, HTTP methods, and request body shapes, then asserts
// `FrontendExtractor.extractApiCalls` recovers the URL, method, sent data
// type, and line number exactly. All generated source is plain in-memory
// text (no filesystem I/O), so a higher `numRuns` is affordable.
// ---------------------------------------------------------------------------

import { FrontendExtractor } from '../../src/modules/frontend-backend-comparator/frontend-extractor';

type FrontendBodyPropKind = 'string' | 'number' | 'boolean';

interface FrontendBodyProp {
  key: string;
  kind: FrontendBodyPropKind;
  literal: string;
}

const frontendIdentifierArbitrary = fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,8}$/);
const frontendUrlSegmentArbitrary = fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/);
const frontendUrlArbitrary = fc
  .array(frontendUrlSegmentArbitrary, { minLength: 1, maxLength: 3 })
  .map((segments) => '/' + segments.join('/'));

const frontendMethodArbitrary = fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH');

const frontendBodyPropArbitrary: fc.Arbitrary<FrontendBodyProp> = fc
  .oneof(
    fc.stringMatching(/^[a-zA-Z0-9 ]{0,10}$/).map((value) => ({ kind: 'string' as const, literal: `'${value}'` })),
    // Non-negative only: a negative numeric literal (`-1`) parses as a
    // PrefixUnaryExpression wrapping a NumericLiteral, not a NumericLiteral
    // itself, so the extractor's best-effort inferrer (matching how bare
    // identifiers are handled) reports it as 'unknown' by design.
    fc.nat({ max: 1000 }).map((value) => ({ kind: 'number' as const, literal: `${value}` })),
    fc.boolean().map((value) => ({ kind: 'boolean' as const, literal: `${value}` })),
  )
  .chain((partial) => frontendIdentifierArbitrary.map((key) => ({ key, ...partial })));

const frontendBodyPropsArbitrary = fc.uniqueArray(frontendBodyPropArbitrary, {
  minLength: 0,
  maxLength: 4,
  selector: (p) => p.key,
});

function frontendExpectedProperties(bodyProps: FrontendBodyProp[]): Record<string, { type: FrontendBodyPropKind }> {
  const properties: Record<string, { type: FrontendBodyPropKind }> = {};
  for (const p of bodyProps) {
    properties[p.key] = { type: p.kind };
  }
  return properties;
}

function frontendBodyObjectLiteralText(bodyProps: FrontendBodyProp[]): string {
  return `{ ${bodyProps.map((p) => `${p.key}: ${p.literal}`).join(', ')} }`;
}

describe('FrontendExtractor.extractApiCalls property tests', () => {
  // Feature: pluvianidae-mvp, Property 13: Frontend API call extraction
  // Validates: Requirements 5.2
  it('extracts URL, method, sent data type and line for synthesized fetch()/axios calls', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('fetch', 'axiosVerb', 'axiosConfig'),
        frontendUrlArbitrary,
        frontendMethodArbitrary,
        fc.boolean(), // uppercase method text in source (string-literal styles only)
        frontendBodyPropsArbitrary,
        fc.boolean(), // whether axiosConfig includes an explicit `method` prop at all
        fc.integer({ min: 0, max: 5 }), // leading blank lines, to vary the call's line number
        (style, url, method, upperCaseInSource, bodyProps, includeMethodProp, leadingBlankLines) => {
          const sourceMethodText = upperCaseInSource ? method : method.toLowerCase();
          const filePath = '/repo/generated.ts';

          let callExpr: string;
          let expectedMethod = method;
          let expectedSentDataType:
            | { type: 'object'; properties: Record<string, { type: FrontendBodyPropKind }>; required: string[] }
            | undefined;

          if (style === 'fetch') {
            const bodyPart = bodyProps.length > 0 ? `, body: JSON.stringify(${frontendBodyObjectLiteralText(bodyProps)})` : '';
            callExpr = `fetch('${url}', { method: '${sourceMethodText}'${bodyPart} })`;
            expectedSentDataType =
              bodyProps.length > 0
                ? { type: 'object', properties: frontendExpectedProperties(bodyProps), required: bodyProps.map((p) => p.key) }
                : undefined;
          } else if (style === 'axiosVerb') {
            const methodLower = method.toLowerCase();
            const includeData = (methodLower === 'post' || methodLower === 'put' || methodLower === 'patch') && bodyProps.length > 0;
            const dataArgText = includeData ? `, ${frontendBodyObjectLiteralText(bodyProps)}` : '';
            callExpr = `axios.${methodLower}('${url}'${dataArgText})`;
            expectedSentDataType = includeData
              ? { type: 'object', properties: frontendExpectedProperties(bodyProps), required: bodyProps.map((p) => p.key) }
              : undefined;
          } else {
            // axiosConfig
            const methodPart = includeMethodProp ? `, method: '${sourceMethodText}'` : '';
            const dataPart = bodyProps.length > 0 ? `, data: ${frontendBodyObjectLiteralText(bodyProps)}` : '';
            callExpr = `axios({ url: '${url}'${methodPart}${dataPart} })`;
            expectedMethod = includeMethodProp ? method : 'GET';
            expectedSentDataType =
              bodyProps.length > 0
                ? { type: 'object', properties: frontendExpectedProperties(bodyProps), required: bodyProps.map((p) => p.key) }
                : undefined;
          }

          const source = '\n'.repeat(leadingBlankLines) + `const result = ${callExpr};\n`;
          const expectedLine = leadingBlankLines + 1;

          const extractor = new FrontendExtractor();
          const calls = extractor.extractApiCalls(filePath, source);

          expect(calls).toHaveLength(1);
          const call = calls[0];

          expect(call.filePath).toBe(filePath);
          expect(call.url).toBe(url);
          expect(call.method).toBe(expectedMethod);
          expect(call.line).toBe(expectedLine);

          if (expectedSentDataType === undefined) {
            expect(call.sentDataType).toBeUndefined();
          } else {
            expect(call.sentDataType?.type).toBe('object');
            expect(call.sentDataType?.properties).toEqual(expectedSentDataType.properties);
            expect(call.sentDataType?.required).toEqual(expect.arrayContaining(expectedSentDataType.required));
            expect(call.sentDataType?.required).toHaveLength(expectedSentDataType.required.length);
          }
        },
      ),
      { numRuns: 75 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: pluvianidae-mvp, Property 15: Type and method incompatibility detection
// Validates: Requirements 5.5, 5.6
//
// *For any* pair of matching frontend call and backend endpoint, if the
// types sent by the frontend differ from those expected by the backend, or
// if HTTP methods or route patterns differ, the Comparador SHALL report
// each discrepancy with locations of both sides.
//
// This test constructs `EndpointEntry`/`FrontendApiCall` pairs directly
// (bypassing file parsing) by injecting stub extractors into
// `FrontendBackendComparator`, isolating the type-mismatch /
// method-mismatch reporting logic (`compareSchemas` and the method-mismatch
// branch of `compare`) from the connection-matching concern covered by
// Property 14 (task 8.6).
// ---------------------------------------------------------------------------

import { IFileContentReader } from '../../src/modules/frontend-backend-comparator/comparator';
import { TypeSchema } from '../../src/core/models';

/**
 * Builds a minimal `RepositoryIndex` containing a single indexed file at
 * `filePath`, which is all `FrontendBackendComparator.analyze()` reads from
 * `getIndex()` (it iterates `index.files.keys()` to know which files to run
 * the extractors against).
 */
function makeSingleFileIndexForTypeTest(filePath: string): RepositoryIndex {
  const fileEntry: FileEntry = {
    path: filePath,
    relativePath: filePath,
    extension: '.ts',
    lastModified: new Date(),
    symbols: [],
    imports: [],
    exports: [],
  };
  return {
    rootPath: '/repo',
    files: new Map([[filePath, fileEntry]]),
    symbols: new Map(),
    importGraph: new Map(),
    exportGraph: new Map(),
    endpoints: [],
    lastUpdated: new Date(),
  };
}

/** No-op file reader: the stub extractors below ignore `sourceText` entirely. */
const noopFileReaderForTypeTest: IFileContentReader = {
  async readFile(): Promise<string> {
    return '';
  },
};

function makeComparatorForTypeTest(
  filePath: string,
  endpoint: EndpointEntry,
  call: FrontendApiCall,
): FrontendBackendComparator {
  const indexSource: Pick<IIndexer, 'getIndex'> = {
    getIndex: () => makeSingleFileIndexForTypeTest(filePath),
  };
  const backendExtractor: IBackendExtractor = {
    extractEndpoints: () => [endpoint],
  };
  const frontendExtractor: IFrontendExtractor = {
    extractApiCalls: () => [call],
  };

  return new FrontendBackendComparator(indexSource, backendExtractor, frontendExtractor, noopFileReaderForTypeTest);
}

const fieldNameArbitrary = fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,8}$/);
const literalRouteArbitrary = fc
  .array(fieldNameArbitrary, { minLength: 1, maxLength: 3 })
  .map((segments) => `/${segments.join('/')}`);

/** Methods whose calls/endpoints are expected to carry a request body (mirrors comparator.ts's BODY_METHODS). */
const bodyMethodArbitraryForTypeTest = fc.constantFrom<HttpMethod>('POST', 'PUT', 'PATCH');
const allMethodsArbitraryForTypeTest = fc.constantFrom<HttpMethod>('GET', 'POST', 'PUT', 'DELETE', 'PATCH');

/** Concrete (non-wildcard) primitive type names — comparator.ts treats 'any'/'unknown' as wildcards, not mismatches. */
const concreteTypeArbitrary = fc.constantFrom('string', 'number', 'boolean', 'object', 'array');

const distinctTypePairArbitrary = fc
  .tuple(concreteTypeArbitrary, concreteTypeArbitrary)
  .filter(([a, b]) => a !== b);

describe('FrontendBackendComparator type/method incompatibility property tests', () => {
  // Feature: pluvianidae-mvp, Property 15: Type and method incompatibility detection
  // Validates: Requirements 5.5, 5.6
  it('reports a TypeIncompatibility referencing both locations when a shared field type differs', async () => {
    await fc.assert(
      fc.asyncProperty(
        literalRouteArbitrary,
        bodyMethodArbitraryForTypeTest,
        fieldNameArbitrary,
        distinctTypePairArbitrary,
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 500 }),
        async (route, method, field, [backendType, frontendType], endpointLine, callLine) => {
          const filePath = '/repo/src/routes.ts';

          const backendSchema: TypeSchema = {
            type: 'object',
            properties: { [field]: { type: backendType } },
            required: [field],
          };
          const frontendSchema: TypeSchema = {
            type: 'object',
            properties: { [field]: { type: frontendType } },
            required: [field],
          };

          const endpoint: EndpointEntry = {
            route,
            method,
            filePath,
            line: endpointLine,
            parameters: [],
            bodySchema: backendSchema,
          };
          const call: FrontendApiCall = {
            url: route,
            method,
            filePath,
            line: callLine,
            sentDataType: frontendSchema,
          };

          const comparator = makeComparatorForTypeTest(filePath, endpoint, call);
          const report = await comparator.analyze();

          expect(report.typeIncompatibilities).toHaveLength(1);
          const incompatibility = report.typeIncompatibilities[0];

          expect(incompatibility.endpoint).toBe(`${method} ${route}`);
          expect(incompatibility.backendExpected).toContain(`${field}: ${backendType}`);
          expect(incompatibility.frontendSends).toContain(`${field}: ${frontendType}`);

          // Both sides' locations must be present and correctly attributed.
          expect(incompatibility.backendLocation).toEqual({ filePath, line: endpointLine, column: 0 });
          expect(incompatibility.frontendLocation).toEqual({ filePath, line: callLine, column: 0 });

          // A pure type mismatch on a shared field is not also reported as a missing-field discrepancy.
          expect(report.discrepancies.filter((d) => d.category === 'missing-field')).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: pluvianidae-mvp, Property 15: Type and method incompatibility detection
  // Validates: Requirements 5.5, 5.6
  it('reports a method-mismatch discrepancy when a matching route is called with a different HTTP method', async () => {
    await fc.assert(
      fc.asyncProperty(
        literalRouteArbitrary,
        fc.tuple(allMethodsArbitraryForTypeTest, allMethodsArbitraryForTypeTest).filter(([a, b]) => a !== b),
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 500 }),
        async (route, [endpointMethod, callMethod], endpointLine, callLine) => {
          const filePath = '/repo/src/routes.ts';

          const endpoint: EndpointEntry = {
            route,
            method: endpointMethod,
            filePath,
            line: endpointLine,
            parameters: [],
          };
          const call: FrontendApiCall = {
            url: route,
            method: callMethod,
            filePath,
            line: callLine,
          };

          const comparator = makeComparatorForTypeTest(filePath, endpoint, call);
          const report = await comparator.analyze();

          expect(report.discrepancies).toHaveLength(1);
          const discrepancy = report.discrepancies[0];
          expect(discrepancy.category).toBe('method-mismatch');
          expect(discrepancy.sourceFile).toBe(filePath);
          expect(discrepancy.sourceLine).toBe(callLine);
          // The description must reference both sides: the call's route/method and the endpoint's route/method.
          expect(discrepancy.description).toContain(route);
          expect(discrepancy.description).toContain(callMethod);
          expect(discrepancy.description).toContain(endpointMethod);

          // A method-mismatched pair must not also be reported as unconsumed or missing.
          expect(report.unconsumedEndpoints).toEqual([]);
          expect(report.missingEndpoints).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
