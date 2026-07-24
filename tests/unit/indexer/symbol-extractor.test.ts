import { describe, expect, it } from 'vitest';
import { SymbolExtractor } from '../../../src/modules/indexer/symbol-extractor';

describe('SymbolExtractor', () => {
  const extractor = new SymbolExtractor();

  it('extracts a function declaration with parameters and return type', () => {
    const source = `
      function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const { symbols } = extractor.extractFromSource('/repo/math.ts', source);

    const addSymbol = symbols.find((s) => s.name === 'add');
    expect(addSymbol).toBeDefined();
    expect(addSymbol?.type).toBe('function');
    expect(addSymbol?.filePath).toBe('/repo/math.ts');
    expect(addSymbol?.line).toBe(2);
    expect(addSymbol?.returnType).toBe('number');
    expect(addSymbol?.parameters).toEqual([
      { name: 'a', type: 'number', required: true, source: 'query' },
      { name: 'b', type: 'number', required: true, source: 'query' },
    ]);
  });

  it('extracts a class declaration and its methods', () => {
    const source = `
      class Calculator {
        add(a: number, b: number): number {
          return a + b;
        }
      }
    `;
    const { symbols } = extractor.extractFromSource('/repo/calculator.ts', source);

    const classSymbol = symbols.find((s) => s.name === 'Calculator');
    expect(classSymbol).toBeDefined();
    expect(classSymbol?.type).toBe('class');

    const methodSymbol = symbols.find((s) => s.name === 'add' && s.type === 'function');
    expect(methodSymbol).toBeDefined();
  });

  it('detects a JSX-returning arrow function as a component', () => {
    const source = `
      const Greeting = (props) => {
        return <div>Hello, {props.name}</div>;
      };
    `;
    const { symbols } = extractor.extractFromSource('/repo/Greeting.tsx', source);

    const componentSymbol = symbols.find((s) => s.name === 'Greeting');
    expect(componentSymbol).toBeDefined();
    expect(componentSymbol?.type).toBe('component');
  });

  it('detects a class extending React.Component as a component', () => {
    const source = `
      class Panel extends React.Component {
        render() {
          return <div />;
        }
      }
    `;
    const { symbols } = extractor.extractFromSource('/repo/Panel.tsx', source);

    const componentSymbol = symbols.find((s) => s.name === 'Panel');
    expect(componentSymbol).toBeDefined();
    expect(componentSymbol?.type).toBe('component');
  });

  it('does not misclassify a lowercase-named JSX-returning function as a component', () => {
    const source = `
      function renderRow(item) {
        return <li>{item}</li>;
      }
    `;
    const { symbols } = extractor.extractFromSource('/repo/render.tsx', source);

    const fnSymbol = symbols.find((s) => s.name === 'renderRow');
    expect(fnSymbol).toBeDefined();
    expect(fnSymbol?.type).toBe('function');
  });

  it('extracts default and named imports', () => {
    const source = `
      import React from 'react';
      import { useState, useEffect as useEffectAlias } from 'react';
      import * as path from 'path';
    `;
    const { imports } = extractor.extractFromSource('/repo/App.tsx', source);

    expect(imports).toContainEqual({ source: 'react', specifiers: ['React'], isDefault: true, line: 2 });
    expect(imports).toContainEqual({
      source: 'react',
      specifiers: ['useState', 'useEffectAlias'],
      isDefault: false,
      line: 3,
    });
    expect(imports).toContainEqual({ source: 'path', specifiers: ['path'], isDefault: false, line: 4 });
  });

  it('extracts named and default exports', () => {
    const source = `
      export function helper() {}
      const value = 42;
      export { value };
      export default helper;
    `;
    const { exports } = extractor.extractFromSource('/repo/exports.ts', source);

    expect(exports.some((e) => e.name === 'helper' && !e.isDefault)).toBe(true);
    expect(exports.some((e) => e.name === 'value' && !e.isDefault)).toBe(true);
    expect(exports.some((e) => e.name === 'helper' && e.isDefault)).toBe(true);
  });

  it('detects Express-style endpoint registrations', () => {
    const source = `
      const app = express();
      app.get('/users', (req, res) => {
        res.send([]);
      });
      router.post('/users', createUser);
    `;
    const { endpoints, symbols } = extractor.extractFromSource('/repo/routes.ts', source);

    expect(endpoints).toContainEqual(
      expect.objectContaining({ route: '/users', method: 'GET', filePath: '/repo/routes.ts' }),
    );
    expect(endpoints).toContainEqual(
      expect.objectContaining({ route: '/users', method: 'POST', filePath: '/repo/routes.ts' }),
    );
    expect(symbols.some((s) => s.type === 'endpoint' && s.name === 'GET /users')).toBe(true);
  });

  it('does not misidentify unrelated get/post calls as endpoints', () => {
    const source = `
      const value = cache.get('key');
    `;
    const { endpoints } = extractor.extractFromSource('/repo/cache.ts', source);

    expect(endpoints).toHaveLength(0);
  });
});
