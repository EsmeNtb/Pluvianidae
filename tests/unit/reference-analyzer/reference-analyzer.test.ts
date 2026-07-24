import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IndexBuilder } from '../../../src/modules/indexer/index-builder';
import {
  ReferenceAnalyzer,
  SymbolNotFoundError,
} from '../../../src/modules/reference-analyzer/reference-analyzer';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-reference-analyzer-'));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

describe('ReferenceAnalyzer', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports the definition location, imports, usages, calls (first-level only) and dependents', async () => {
    await writeFile(
      root,
      'src/math.ts',
      [
        'export function helper(): number {',
        '  return 1;',
        '}',
        '',
        'export function add(a: number, b: number): number {',
        '  const h = helper();',
        '  return a + b + h;',
        '}',
        '',
        'function unrelatedCallsHelperToo(): number {',
        '  // This other function also invokes the helper directly, but it',
        '  // is not itself invoked here, so it must not leak into the map.',
        '  return helper();',
        '}',
      ].join('\n'),
    );

    await writeFile(
      root,
      'src/consumer.ts',
      ['import { add } from \'./math\';', '', 'export function useAdd(): number {', '  return add(1, 2);', '}'].join(
        '\n',
      ),
    );

    await writeFile(
      root,
      'src/other.ts',
      ['// this file has no relation to the math module', 'export const unrelated = 42;'].join('\n'),
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const analyzer = new ReferenceAnalyzer(builder);
    const mathFile = path.join(root, 'src', 'math.ts');
    const consumerFile = path.join(root, 'src', 'consumer.ts');

    const referenceMap = await analyzer.getReferences({ name: 'add', filePath: mathFile });

    // Definition (3.1)
    expect(referenceMap.definition).toEqual({ filePath: mathFile, line: 5, column: 1 });

    // Imports (3.2)
    expect(referenceMap.imports).toEqual([{ filePath: consumerFile, line: 1, column: 1 }]);

    // Usages (3.3): the call inside consumer.ts's useAdd, excluding the definition line itself.
    expect(referenceMap.usages).toHaveLength(1);
    expect(referenceMap.usages[0]).toMatchObject({
      filePath: consumerFile,
      line: 4,
      context: 'return add(1, 2);',
    });

    // Calls (3.4): add() calls helper() directly (first level only).
    expect(referenceMap.calls).toHaveLength(1);
    expect(referenceMap.calls[0]).toMatchObject({ filePath: mathFile, line: 1 });

    // Dependents (3.5): files that import this specific symbol.
    expect(referenceMap.dependents).toEqual([consumerFile]);
  });

  it('does not include transitive (second-level) calls', async () => {
    await writeFile(
      root,
      'src/chain.ts',
      [
        'export function level2(): number {',
        '  return 2;',
        '}',
        '',
        'export function level1(): number {',
        '  return level2();',
        '}',
        '',
        'export function level0(): number {',
        '  return level1();',
        '}',
      ].join('\n'),
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);
    const analyzer = new ReferenceAnalyzer(builder);

    const referenceMap = await analyzer.getReferences({ name: 'level0' });

    const calledNames = referenceMap.calls.map((c) => c.line);
    expect(referenceMap.calls).toHaveLength(1);
    // level0 calls level1 directly; level2 (called by level1) must not appear.
    const chainFile = path.join(root, 'src', 'chain.ts');
    expect(referenceMap.calls[0]).toEqual({ filePath: chainFile, line: 5, column: 1 });
    expect(calledNames).not.toContain(1); // level2 is declared at line 1
  });

  it('throws SymbolNotFoundError with possible causes when the symbol is not in the index', async () => {
    await writeFile(root, 'src/only.ts', 'export const known = 1;\n');

    const builder = new IndexBuilder();
    await builder.indexRepository(root);
    const analyzer = new ReferenceAnalyzer(builder);

    await expect(analyzer.getReferences({ name: 'doesNotExist' })).rejects.toThrow(SymbolNotFoundError);
    await expect(analyzer.getReferences({ name: 'doesNotExist' })).rejects.toThrow(/no se encontró/i);
    await expect(analyzer.getReferences({ name: 'doesNotExist' })).rejects.toThrow(/no ha sido indexado/i);
    await expect(analyzer.getReferences({ name: 'doesNotExist' })).rejects.toThrow(/dependencia/i);
  });

  it('resolves symbols by symbolId directly', async () => {
    await writeFile(root, 'src/single.ts', 'export function solo(): void {}\n');

    const builder = new IndexBuilder();
    await builder.indexRepository(root);
    const index = builder.getIndex();
    const symbol = Array.from(index.symbols.values()).find((s) => s.name === 'solo');
    expect(symbol).toBeDefined();

    const analyzer = new ReferenceAnalyzer(builder);
    const referenceMap = await analyzer.getReferences({ symbolId: symbol!.id });

    expect(referenceMap.definition).toEqual({ filePath: symbol!.filePath, line: 1, column: 1 });
  });
});
