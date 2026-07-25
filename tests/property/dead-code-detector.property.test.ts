import { describe, it, afterEach, expect } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IndexBuilder } from '../../src/modules/indexer/index-builder';
import { DeadCodeDetector, DeadCodeFindingType, ConfidenceLevel } from '../../src/modules/dead-code-detector/dead-code-detector';

/**
 * Unique, syntactically-valid identifier generator. Truly arbitrary source
 * generation risks invalid syntax, so instead a small, guaranteed-valid
 * name is randomized and interpolated into a fixed fixture template (same
 * approach as the existing indexer property tests).
 */
const identifierArbitrary = fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,10}$/);

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-dead-code-prop-'));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

async function analyzeRepo(root: string) {
  const builder = new IndexBuilder();
  await builder.indexRepository(root);
  const detector = new DeadCodeDetector(builder);
  return detector.analyze();
}

function findingsOfType(
  report: { findings: { type: DeadCodeFindingType; confidence: ConfidenceLevel; description: string }[] },
  type: DeadCodeFindingType,
  name: string,
) {
  return report.findings.filter((f) => f.type === type && f.description.includes(`"${name}"`));
}

describe('DeadCodeDetector property tests', () => {
  const tempDirsToClean: string[] = [];

  afterEach(async () => {
    while (tempDirsToClean.length > 0) {
      const dir = tempDirsToClean.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Feature: pluvianidae-mvp, Property 10: Dead code detection accuracy
  it('assigns confidence "alto" to a function that is declared but never invoked anywhere in the repository', async () => {
    await fc.assert(
      fc.asyncProperty(identifierArbitrary, async (name) => {
        const root = await makeTempDir();
        tempDirsToClean.push(root);

        // Sole declaration of `name`; a sibling file exists but never
        // references it, so this is a zero-reference (whole-repository)
        // unused function.
        await writeFile(root, 'src/lonely.ts', `export function ${name}(): void {\n  console.log('dead');\n}\n`);
        await writeFile(root, 'src/sibling.ts', `export const unrelated = 1;\n`);

        const report = await analyzeRepo(root);

        const matches = findingsOfType(report, 'unused-function', name);
        expect(matches).toHaveLength(1);
        expect(matches[0].confidence).toBe('alto');
      }),
      // Real filesystem I/O (temp dir + writes + full repository index +
      // analysis pass) happens on every iteration, so a moderate run count
      // is used to keep the suite fast while still covering many names.
      { numRuns: 25 },
    );
  });

  // Feature: pluvianidae-mvp, Property 10: Dead code detection accuracy
  it('assigns confidence "medio" to a function referenced only from a test-pattern file', async () => {
    await fc.assert(
      fc.asyncProperty(identifierArbitrary, async (name) => {
        const root = await makeTempDir();
        tempDirsToClean.push(root);

        // Declared in a main source file but never called there.
        await writeFile(root, 'src/feature.ts', `export function ${name}(): void {\n  console.log('feature');\n}\n`);
        // Only genuine call site lives in a separate test-pattern file.
        await writeFile(
          root,
          'src/feature.test.ts',
          `import { ${name} } from './feature';\ndescribe('${name}', () => {\n  it('works', () => {\n    ${name}();\n  });\n});\n`,
        );

        const report = await analyzeRepo(root);

        const matches = findingsOfType(report, 'unused-function', name);
        expect(matches).toHaveLength(1);
        expect(matches[0].confidence).toBe('medio');
      }),
      // Same real-fs-per-iteration tradeoff as above.
      { numRuns: 25 },
    );
  });

  // Feature: pluvianidae-mvp, Property 10: Dead code detection accuracy
  it('assigns confidence "alto" to an unused import with zero references', async () => {
    await fc.assert(
      fc.asyncProperty(identifierArbitrary, async (name) => {
        const root = await makeTempDir();
        tempDirsToClean.push(root);

        await writeFile(root, 'src/other.ts', `export function ${name}(): void {}\n`);
        await writeFile(root, 'src/index.ts', `import { ${name} } from './other';\nconsole.log('unrelated');\n`);

        const report = await analyzeRepo(root);

        const matches = findingsOfType(report, 'unused-import', name);
        expect(matches).toHaveLength(1);
        expect(matches[0].confidence).toBe('alto');
      }),
      { numRuns: 25 },
    );
  });

  // Feature: pluvianidae-mvp, Property 10: Dead code detection accuracy
  it('assigns confidence "alto" to an unused local variable with zero references', async () => {
    await fc.assert(
      fc.asyncProperty(identifierArbitrary, async (name) => {
        const root = await makeTempDir();
        tempDirsToClean.push(root);

        await writeFile(
          root,
          'src/calc.ts',
          `export function run(): number {\n  const ${name} = 1;\n  return 2;\n}\n`,
        );

        const report = await analyzeRepo(root);

        const matches = findingsOfType(report, 'unused-variable', name);
        expect(matches).toHaveLength(1);
        expect(matches[0].confidence).toBe('alto');
      }),
      { numRuns: 25 },
    );
  });

  // Feature: pluvianidae-mvp, Property 10: Dead code detection accuracy
  it('assigns confidence "alto" to an unused function parameter with zero references in the body', async () => {
    await fc.assert(
      fc.asyncProperty(identifierArbitrary, async (name) => {
        const root = await makeTempDir();
        tempDirsToClean.push(root);

        await writeFile(root, 'src/fn.ts', `export function f(${name}: number): number {\n  return 1;\n}\n`);

        const report = await analyzeRepo(root);

        const matches = findingsOfType(report, 'unused-parameter', name);
        expect(matches).toHaveLength(1);
        expect(matches[0].confidence).toBe('alto');
      }),
      { numRuns: 25 },
    );
  });
});
