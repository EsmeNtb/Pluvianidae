import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IndexBuilder } from '../../../src/modules/indexer/index-builder';
import { DeadCodeDetector } from '../../../src/modules/dead-code-detector/dead-code-detector';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-dead-code-'));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

describe('DeadCodeDetector', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('detects an unused import with confidence "alto"', async () => {
    await writeFile(root, 'src/math.ts', `export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    await writeFile(
      root,
      'src/index.ts',
      `import { add } from './math';\nimport { subtract } from './math';\nconsole.log(add(1, 2));\n`,
    );
    // math.ts only exports add, but pretend subtract exists too by exporting it for realism.
    await writeFile(
      root,
      'src/math.ts',
      `export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n`,
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const detector = new DeadCodeDetector(builder);
    const report = await detector.analyze();

    const indexFile = path.join(root, 'src', 'index.ts');
    const unusedImportFindings = report.findings.filter(
      (f) => f.type === 'unused-import' && f.filePath === indexFile,
    );
    expect(unusedImportFindings).toHaveLength(1);
    expect(unusedImportFindings[0]).toMatchObject({
      confidence: 'alto',
      line: 2,
      suggestedAction: 'eliminar',
    });
  });

  it('detects an unused parameter with confidence "alto"', async () => {
    await writeFile(
      root,
      'src/greet.ts',
      `export function greet(name: string, unusedFlag: boolean): string {\n  return 'Hello ' + name;\n}\n`,
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const detector = new DeadCodeDetector(builder);
    const report = await detector.analyze();

    const filePath = path.join(root, 'src', 'greet.ts');
    const unusedParamFindings = report.findings.filter(
      (f) => f.type === 'unused-parameter' && f.filePath === filePath,
    );
    expect(unusedParamFindings).toHaveLength(1);
    expect(unusedParamFindings[0]).toMatchObject({
      confidence: 'alto',
      suggestedAction: 'eliminar',
    });
    expect(unusedParamFindings[0].description).toContain('unusedFlag');
  });

  it('detects an unused function (never called anywhere) with confidence "alto"', async () => {
    await writeFile(
      root,
      'src/utils.ts',
      `export function neverCalled(): void {\n  console.log('dead');\n}\n\nexport function used(): void {\n  console.log('alive');\n}\n`,
    );
    await writeFile(root, 'src/index.ts', `import { used } from './utils';\nused();\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const detector = new DeadCodeDetector(builder);
    const report = await detector.analyze();

    const utilsFile = path.join(root, 'src', 'utils.ts');
    const unusedFunctionFindings = report.findings.filter(
      (f) => f.type === 'unused-function' && f.filePath === utilsFile,
    );
    expect(unusedFunctionFindings).toHaveLength(1);
    expect(unusedFunctionFindings[0]).toMatchObject({ confidence: 'alto', suggestedAction: 'eliminar' });
    expect(unusedFunctionFindings[0].description).toContain('neverCalled');

    // 'used' must not be flagged since it's called from index.ts.
    expect(report.findings.some((f) => f.type === 'unused-function' && f.description.includes('"used"'))).toBe(
      false,
    );
  });

  it('detects orphan files while excluding test-pattern files', async () => {
    await writeFile(root, 'src/main.ts', `export const main = () => console.log('main');\n`);
    await writeFile(root, 'src/orphan.ts', `export const orphan = () => console.log('orphan');\n`);
    await writeFile(root, 'src/orphan.test.ts', `describe('orphan', () => {});\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const detector = new DeadCodeDetector(builder);
    const report = await detector.analyze();

    const orphanPath = path.join(root, 'src', 'orphan.ts');
    const testPath = path.join(root, 'src', 'orphan.test.ts');
    const mainPath = path.join(root, 'src', 'main.ts');

    const orphanFindings = report.findings.filter((f) => f.type === 'orphan-file');
    const orphanFilePaths = orphanFindings.map((f) => f.filePath);

    expect(orphanFilePaths).toContain(orphanPath);
    expect(orphanFilePaths).toContain(mainPath);
    expect(orphanFilePaths).not.toContain(testPath);
  });

  it('registers a file with syntax errors as unanalyzable and continues analyzing the rest', async () => {
    await writeFile(root, 'src/good.ts', `export function ok(): void {\n  console.log('ok');\n}\n`);
    await writeFile(root, 'src/bad.ts', `export function broken( {{{ this is not valid syntax\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const detector = new DeadCodeDetector(builder);
    const report = await detector.analyze();

    const badPath = path.join(root, 'src', 'bad.ts');
    const goodPath = path.join(root, 'src', 'good.ts');

    expect(report.unanalyzableFiles.some((u) => u.filePath === badPath)).toBe(true);
    expect(report.unanalyzableFiles.find((u) => u.filePath === badPath)?.reason).toBeTruthy();

    // Analysis of the rest of the repository still happened (good.ts wasn't skipped as a side effect).
    expect(report.unanalyzableFiles.some((u) => u.filePath === goodPath)).toBe(false);
  });

  it('returns a well-shaped report with duration and all expected arrays present', async () => {
    await writeFile(root, 'src/empty.ts', `export const noop = () => {};\n`);

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const detector = new DeadCodeDetector(builder);
    const report = await detector.analyze();

    expect(typeof report.duration).toBe('number');
    expect(report.duration).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.findings)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(Array.isArray(report.unanalyzableFiles)).toBe(true);
  });

  it('populates warnings with commented-code findings from code-warnings.ts', async () => {
    await writeFile(
      root,
      'src/legacy.ts',
      [
        'export function used(): void {',
        '// const old = 1;',
        '// const older = 2;',
        '// const oldest = 3;',
        "  console.log('used');",
        '}',
        '',
      ].join('\n'),
    );

    const builder = new IndexBuilder();
    await builder.indexRepository(root);

    const detector = new DeadCodeDetector(builder);
    const report = await detector.analyze();

    const filePath = path.join(root, 'src', 'legacy.ts');
    const commentedWarnings = report.warnings.filter((w) => w.type === 'commented-code' && w.filePath === filePath);
    expect(commentedWarnings).toHaveLength(1);
    expect(commentedWarnings[0]).toMatchObject({ startLine: 2, endLine: 4 });
  });
});
