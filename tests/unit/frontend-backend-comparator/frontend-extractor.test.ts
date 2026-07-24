import { describe, expect, it } from 'vitest';
import { FrontendExtractor } from '../../../src/modules/frontend-backend-comparator/frontend-extractor';

describe('FrontendExtractor', () => {
  const extractor = new FrontendExtractor();

  it('extracts a fetch() call with default GET method when no options are given', () => {
    const source = `
      async function loadUsers() {
        const res = await fetch('/api/users');
        return res.json();
      }
    `;
    const calls = extractor.extractApiCalls('/repo/loadUsers.ts', source);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/api/users',
      method: 'GET',
      filePath: '/repo/loadUsers.ts',
    });
    expect(calls[0].sentDataType).toBeUndefined();
  });

  it('extracts a fetch() call with explicit POST method and infers sentDataType from JSON.stringify body', () => {
    const source = `
      async function createUser(name: string, age: number) {
        return fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, age: age, active: true }),
        });
      }
    `;
    const calls = extractor.extractApiCalls('/repo/createUser.ts', source);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('/api/users');
    expect(call.method).toBe('POST');
    expect(call.sentDataType).toBeDefined();
    expect(call.sentDataType?.type).toBe('object');
    // `name` and `age` are sent as identifier references (not literals), so
    // the best-effort inferrer records them as 'unknown'; `active: true` is
    // a literal boolean and is inferred correctly.
    expect(call.sentDataType?.properties).toMatchObject({
      name: { type: 'unknown' },
      age: { type: 'unknown' },
      active: { type: 'boolean' },
    });
    expect(call.sentDataType?.required).toEqual(expect.arrayContaining(['name', 'age', 'active']));
  });

  it('extracts axios.get and axios.post call styles', () => {
    const source = `
      function fetchOrders() {
        return axios.get('/api/orders');
      }
      function createOrder(payload: { total: number }) {
        return axios.post('/api/orders', { total: payload.total, currency: 'USD' });
      }
    `;
    const calls = extractor.extractApiCalls('/repo/orders.ts', source);

    expect(calls).toHaveLength(2);

    const getCall = calls.find((c) => c.method === 'GET');
    expect(getCall).toBeDefined();
    expect(getCall?.url).toBe('/api/orders');
    expect(getCall?.sentDataType).toBeUndefined();

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall).toBeDefined();
    expect(postCall?.url).toBe('/api/orders');
    expect(postCall?.sentDataType?.type).toBe('object');
    expect(postCall?.sentDataType?.properties?.currency).toEqual({ type: 'string' });
  });

  it('extracts an axios(config) style call, defaulting method to GET when omitted', () => {
    const source = `
      function fetchProfile(id: string) {
        return axios({ url: '/api/profile' });
      }
    `;
    const calls = extractor.extractApiCalls('/repo/profile.ts', source);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/profile', method: 'GET' });
  });

  it('extracts an axios(config) style call with explicit method and data', () => {
    const source = `
      function updateProfile(id: string) {
        return axios({ url: '/api/profile', method: 'put', data: { bio: 'hello' } });
      }
    `;
    const calls = extractor.extractApiCalls('/repo/profile.ts', source);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/profile');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].sentDataType?.properties?.bio).toEqual({ type: 'string' });
  });

  it('preserves the literal path suffix when the URL is built from an environment variable', () => {
    const source = `
      async function loadConfig() {
        return fetch(\`\${process.env.API_URL}/config\`);
      }
    `;
    const calls = extractor.extractApiCalls('/repo/config.ts', source);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('${process.env.API_URL}/config');
    expect(calls[0].method).toBe('GET');
  });

  it('preserves the literal path suffix for import.meta.env (Vite-style) URLs', () => {
    const source = `
      async function loadOrders() {
        return fetch(\`\${import.meta.env.VITE_API_URL}/orders\`, { method: 'GET' });
      }
    `;
    const calls = extractor.extractApiCalls('/repo/orders-vite.ts', source);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('${import.meta.env.VITE_API_URL}/orders');
  });

  it('does not crash on a custom hook call site with no same-file definition, and extracts nothing for it', () => {
    const source = `
      function UsersList() {
        const { data } = useUsers();
        return data;
      }
    `;
    const calls = extractor.extractApiCalls('/repo/UsersList.tsx', source);

    // No same-file `useUsers` definition exists, so no call details can be
    // recovered from the call site alone (known limitation) — but this
    // must not throw and must not fabricate a call.
    expect(calls).toEqual([]);
  });

  it('attributes fetch/axios calls found inside a same-file custom hook definition to the hook location', () => {
    const source = `
      function useUsers() {
        return fetch('/api/users');
      }

      function UsersList() {
        const data = useUsers();
        return data;
      }
    `;
    const calls = extractor.extractApiCalls('/repo/useUsers.ts', source);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/users');
    expect(calls[0].method).toBe('GET');
    // Attributed to the hook's own definition line (line 3 inside useUsers), not the call site (line 7).
    expect(calls[0].line).toBe(3);
  });

  it('does not double-count a same-file custom hook body call when also walking the rest of the file', () => {
    const source = `
      const useOrders = () => {
        return axios.get('/api/orders');
      };

      function OrdersList() {
        useOrders();
        return null;
      }
    `;
    const calls = extractor.extractApiCalls('/repo/useOrders.ts', source);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/orders');
  });

  it('returns an empty array for a file with no HTTP calls', () => {
    const source = `
      export function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const calls = extractor.extractApiCalls('/repo/math.ts', source);

    expect(calls).toEqual([]);
  });
});
