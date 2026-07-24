import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IndexBuilder } from '../../../src/modules/indexer/index-builder';
import { FrontendBackendComparator } from '../../../src/modules/frontend-backend-comparator/comparator';
import { IBackendExtractor } from '../../../src/modules/frontend-backend-comparator/backend-extractor';
import { FrontendApiCall, IFrontendExtractor } from '../../../src/modules/frontend-backend-comparator/frontend-extractor';
import { EndpointEntry } from '../../../src/core/models';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-fb-comparator-'));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

describe('FrontendBackendComparator', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('produces no findings for a fully-matched endpoint/call pair', async () => {
    await writeFile(
      root,
      'src/backend/routes.ts',
      `app.get('/users', (req, res) => {\n  res.send([]);\n});\n`,
    );
    await writeFile(
      root,
      'src/frontend/api.ts',
      `async function loadUsers() {\n  return fetch('/users');\n}\n`,
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const comparator = new FrontendBackendComparator(builder);
    const report = await comparator.analyze();

    expect(report.unconsumedEndpoints).toEqual([]);
    expect(report.missingEndpoints).toEqual([]);
    expect(report.typeIncompatibilities).toEqual([]);
    expect(report.discrepancies).toEqual([]);
    expect(report.unanalyzableFiles).toEqual([]);
  });

  it('reports an unconsumed backend endpoint when no frontend call matches its route', async () => {
    await writeFile(
      root,
      'src/backend/routes.ts',
      `app.get('/orders', (req, res) => {\n  res.send([]);\n});\n`,
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const comparator = new FrontendBackendComparator(builder);
    const report = await comparator.analyze();

    expect(report.unconsumedEndpoints).toHaveLength(1);
    expect(report.unconsumedEndpoints[0]).toMatchObject({
      route: '/orders',
      method: 'GET',
      definitionLine: 1,
    });
  });

  it('reports a missing endpoint when no backend endpoint matches a frontend call route', async () => {
    await writeFile(
      root,
      'src/frontend/api.ts',
      `async function loadOrders() {\n  return fetch('/orders');\n}\n`,
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const comparator = new FrontendBackendComparator(builder);
    const report = await comparator.analyze();

    expect(report.missingEndpoints).toHaveLength(1);
    expect(report.missingEndpoints[0]).toMatchObject({
      url: '/orders',
      method: 'GET',
      callLine: 2,
    });
  });

  it('reports a method-mismatch discrepancy and does not also report unconsumed/missing for that pair', async () => {
    await writeFile(
      root,
      'src/backend/routes.ts',
      `app.get('/items', (req, res) => {\n  res.send([]);\n});\n`,
    );
    await writeFile(
      root,
      'src/frontend/api.ts',
      `async function deleteItem() {\n  return fetch('/items', { method: 'DELETE' });\n}\n`,
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const comparator = new FrontendBackendComparator(builder);
    const report = await comparator.analyze();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({ category: 'method-mismatch' });

    expect(report.unconsumedEndpoints.some((e) => e.route === '/items')).toBe(false);
    expect(report.missingEndpoints.some((m) => m.url === '/items')).toBe(false);
  });

  it('reports a type incompatibility when a shared property type differs between frontend and backend', async () => {
    // The real BackendExtractor always infers `'any'` for `req.body`
    // properties (no static type info available from destructuring/access
    // alone), which this comparator treats as a wildcard rather than a
    // mismatch (see comparator.ts's compareSchemas doc comment). To
    // exercise a genuine type mismatch — where BOTH sides have a concrete,
    // differing type for a shared field — stub extractors are injected
    // that report a concrete backend type, consistent with how a richer
    // future extractor (or typed backend framework) might populate
    // `bodySchema`.
    await writeFile(root, 'src/backend/routes.ts', `app.post('/users', (req, res) => {\n  res.send({});\n});\n`);
    await writeFile(
      root,
      'src/frontend/api.ts',
      [
        'async function createUser() {',
        "  return fetch('/users', {",
        "    method: 'POST',",
        "    body: JSON.stringify({ age: 'twenty' }),",
        '  });',
        '}',
        '',
      ].join('\n'),
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const stubBackendExtractor: IBackendExtractor = {
      extractEndpoints(filePath: string): EndpointEntry[] {
        if (!filePath.endsWith(path.join('backend', 'routes.ts'))) {
          return [];
        }
        return [
          {
            route: '/users',
            method: 'POST',
            filePath,
            line: 1,
            parameters: [],
            bodySchema: { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] },
          },
        ];
      },
    };
    const stubFrontendExtractor: IFrontendExtractor = {
      extractApiCalls(filePath: string): FrontendApiCall[] {
        if (!filePath.endsWith(path.join('frontend', 'api.ts'))) {
          return [];
        }
        return [
          {
            url: '/users',
            method: 'POST',
            filePath,
            line: 2,
            sentDataType: { type: 'object', properties: { age: { type: 'string' } }, required: ['age'] },
          },
        ];
      },
    };

    const comparator = new FrontendBackendComparator(builder, stubBackendExtractor, stubFrontendExtractor);
    const report = await comparator.analyze();

    expect(report.typeIncompatibilities).toHaveLength(1);
    expect(report.typeIncompatibilities[0]).toMatchObject({
      endpoint: 'POST /users',
    });
    expect(report.typeIncompatibilities[0].backendExpected).toContain('age: number');
    expect(report.typeIncompatibilities[0].frontendSends).toContain('age: string');
    expect(report.discrepancies.filter((d) => d.category === 'missing-field')).toEqual([]);
  });

  it('reports a missing-field discrepancy when a required backend field is absent from the frontend payload', async () => {
    await writeFile(
      root,
      'src/backend/routes.ts',
      [
        "router.post('/users', (req, res) => {",
        '  const { name, email } = req.body;',
        '  res.send({ name, email });',
        '});',
        '',
      ].join('\n'),
    );
    await writeFile(
      root,
      'src/frontend/api.ts',
      [
        'async function createUser() {',
        "  return fetch('/users', {",
        "    method: 'POST',",
        "    body: JSON.stringify({ name: 'Ada' }),",
        '  });',
        '}',
        '',
      ].join('\n'),
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const comparator = new FrontendBackendComparator(builder);
    const report = await comparator.analyze();

    const missingFieldDiscrepancies = report.discrepancies.filter((d) => d.category === 'missing-field');
    expect(missingFieldDiscrepancies).toHaveLength(1);
    expect(missingFieldDiscrepancies[0].description).toContain('email');
  });

  it('matches a route-param backend route against a literal frontend call URL', async () => {
    await writeFile(
      root,
      'src/backend/routes.ts',
      `app.get('/users/:id', (req, res) => {\n  res.json({ id: req.params.id });\n});\n`,
    );
    await writeFile(
      root,
      'src/frontend/api.ts',
      `async function loadUser() {\n  return fetch('/users/123');\n}\n`,
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const comparator = new FrontendBackendComparator(builder);
    const report = await comparator.analyze();

    expect(report.unconsumedEndpoints).toEqual([]);
    expect(report.missingEndpoints).toEqual([]);
  });

  it('registers a file with a syntax error as unanalyzable and continues analysis', async () => {
    await writeFile(
      root,
      'src/backend/routes.ts',
      `app.get('/users', (req, res) => {\n  res.send([]);\n});\n`,
    );
    await writeFile(root, 'src/backend/bad.ts', `app.get( {{{ this is not valid syntax\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const comparator = new FrontendBackendComparator(builder);
    const report = await comparator.analyze();

    const badPath = path.join(root, 'src', 'backend', 'bad.ts');
    expect(report.unanalyzableFiles.some((u) => u.filePath === badPath)).toBe(true);
    expect(report.unanalyzableFiles.find((u) => u.filePath === badPath)?.reason).toBeTruthy();

    // The valid file was still analyzed: /users endpoint is unconsumed (no matching call).
    expect(report.unconsumedEndpoints.some((e) => e.route === '/users')).toBe(true);
  });
});
