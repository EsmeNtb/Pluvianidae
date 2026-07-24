import { describe, expect, it } from 'vitest';
import { BackendExtractor } from '../../../src/modules/frontend-backend-comparator/backend-extractor';

describe('BackendExtractor', () => {
  const extractor = new BackendExtractor();

  it('extracts route path and HTTP method', () => {
    const source = `
      app.get('/users', (req, res) => {
        res.send([]);
      });
    `;
    const endpoints = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({
      route: '/users',
      method: 'GET',
      filePath: '/repo/routes.ts',
      line: 2,
    });
  });

  it('extracts route params from the path', () => {
    const source = `
      app.get('/users/:id', (req, res) => {
        res.send({});
      });
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.parameters).toContainEqual({
      name: 'id',
      type: 'string',
      required: true,
      source: 'params',
    });
  });

  it('extracts query params accessed in the handler body', () => {
    const source = `
      router.get('/search', (req, res) => {
        const q = req.query.q;
        const page = req.query['page'];
        res.send({ q, page });
      });
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.parameters).toContainEqual({ name: 'q', type: 'string', required: false, source: 'query' });
    expect(endpoint.parameters).toContainEqual({ name: 'page', type: 'string', required: false, source: 'query' });
  });

  it('extracts a body schema from destructured req.body', () => {
    const source = `
      router.post('/users', (req, res) => {
        const { name, email } = req.body;
        res.send({ name, email });
      });
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.bodySchema).toEqual({
      type: 'object',
      properties: { name: { type: 'any' }, email: { type: 'any' } },
      required: ['name', 'email'],
    });
  });

  it('extracts a body schema from property access on req.body', () => {
    const source = `
      router.post('/users', (req, res) => {
        const name = req.body.name;
        res.status(201).json({ ok: true });
      });
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.bodySchema).toEqual({
      type: 'object',
      properties: { name: { type: 'any' } },
      required: ['name'],
    });
  });

  it('falls back to a generic object schema when req.body is used as a whole', () => {
    const source = `
      router.post('/users', (req, res) => {
        createUser(req.body);
        res.send({});
      });
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.bodySchema).toEqual({ type: 'object' });
  });

  it('extracts a response schema from res.json with an object literal', () => {
    const source = `
      app.get('/users/:id', (req, res) => {
        res.json({ id: user.id, name: 'Ada', active: true, tags: ['a'] });
      });
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.responseSchema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'any' },
        name: { type: 'string' },
        active: { type: 'boolean' },
        tags: { type: 'array' },
      },
      required: ['id', 'name', 'active', 'tags'],
    });
  });

  it('falls back to a generic object schema when res.json argument is not a literal', () => {
    const source = `
      app.get('/users/:id', (req, res) => {
        res.json(user);
      });
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.responseSchema).toEqual({ type: 'object' });
  });

  it('resolves a named handler declared in the same file', () => {
    const source = `
      function getUser(req, res) {
        const id = req.params.id;
        res.json({ id });
      }
      app.get('/users/:id', getUser);
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.route).toBe('/users/:id');
    expect(endpoint.method).toBe('GET');
    expect(endpoint.responseSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'any' } },
      required: ['id'],
    });
  });

  it('gracefully handles a named handler that cannot be resolved (imported elsewhere)', () => {
    const source = `
      import { createUser } from './handlers';
      router.post('/users', createUser);
    `;
    const [endpoint] = extractor.extractEndpoints('/repo/routes.ts', source);

    expect(endpoint.route).toBe('/users');
    expect(endpoint.method).toBe('POST');
    expect(endpoint.parameters).toEqual([]);
    expect(endpoint.bodySchema).toBeUndefined();
    expect(endpoint.responseSchema).toBeUndefined();
  });

  it('does not misidentify unrelated get/post calls as endpoints', () => {
    const source = `
      const value = cache.get('key');
    `;
    const endpoints = extractor.extractEndpoints('/repo/cache.ts', source);

    expect(endpoints).toHaveLength(0);
  });
});
