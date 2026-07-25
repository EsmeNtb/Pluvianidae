import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IndexBuilder } from '../../src/modules/indexer/index-builder';
import { ReferenceAnalyzer } from '../../src/modules/reference-analyzer/reference-analyzer';

/**
 * A helper function declared alongside the target symbol in `target.ts`.
 * `called` marks whether the target function's body invokes it directly
 * (first level only) — this is what lets the test assert `calls` (3.4)
 * contains *exactly* the called subset, not just "some" of the helpers.
 */
interface HelperRecord {
  name: string;
  called: boolean;
}

const identifierArbitrary = fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,8}$/);

const helperArbitrary: fc.Arbitrary<HelperRecord> = fc.record({
  name: identifierArbitrary,
  called: fc.boolean(),
});

const helpersArbitrary = fc.uniqueArray(helperArbitrary, {
  minLength: 0,
  maxLength: 4,
  selector: (h) => h.name,
});

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-reference-analyzer-prop-'));
}

describe('ReferenceAnalyzer property tests', () => {
  const tempDirsToClean: string[] = [];

  afterEach(async () => {
    while (tempDirsToClean.length > 0) {
      const dir = tempDirsToClean.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Feature: pluvianidae-mvp, Property 9: Reference map completeness
  it('returns a reference map whose definition, imports, usages, calls and dependents cover exactly the generated repository', async () => {
    await fc.assert(
      fc.asyncProperty(
        identifierArbitrary,
        helpersArbitrary,
        fc.integer({ min: 0, max: 4 }),
        async (targetNameRaw, helpersRaw, consumerCount) => {
          // The target function's own name must not collide with any
          // helper name, otherwise the "which one got called" bookkeeping
          // below would be ambiguous.
          const helpers = helpersRaw.filter((h) => h.name !== targetNameRaw);
          const targetName = targetNameRaw;

          const root = await makeTempDir();
          tempDirsToClean.push(root);

          const calledHelpers = helpers.filter((h) => h.called);

          // Build target.ts deterministically: the target function is
          // always declared on line 1, column 1, and its body invokes
          // (first level only) exactly the helpers marked `called`. Every
          // helper (called or not) is declared as a sibling function in
          // the same file, at a known, tracked line, so `calls` can be
          // checked for *exact* membership (not just "contains some").
          const lines: string[] = [];
          lines.push(`export function ${targetName}(): number {`);
          for (const helper of calledHelpers) {
            lines.push(`  ${helper.name}();`);
          }
          lines.push('  return 1;');
          lines.push('}');
          lines.push('');

          const helperLineByName = new Map<string, number>();
          for (const helper of helpers) {
            helperLineByName.set(helper.name, lines.length + 1);
            lines.push(`function ${helper.name}(): number { return 1; }`);
          }

          const targetFilePath = path.join(root, 'target.ts');
          await fs.writeFile(targetFilePath, lines.join('\n') + '\n', 'utf-8');

          // Consumer files: each imports AND uses (calls) the target
          // symbol, so they exercise imports (3.2), usages (3.3) and
          // dependents (3.5) simultaneously.
          const consumerFilePaths: string[] = [];
          for (let i = 0; i < consumerCount; i++) {
            const consumerFilePath = path.join(root, `consumer${i}.ts`);
            const consumerContent = [
              `import { ${targetName} } from './target';`,
              '',
              `export function consumer${i}(): number {`,
              `  return ${targetName}();`,
              '}',
              '',
            ].join('\n');
            await fs.writeFile(consumerFilePath, consumerContent, 'utf-8');
            consumerFilePaths.push(consumerFilePath);
          }

          const builder = new IndexBuilder();
          await builder.indexRepository(root);
          const analyzer = new ReferenceAnalyzer(builder);

          const referenceMap = await analyzer.getReferences({ name: targetName, filePath: targetFilePath });

          // (a) definition location matches the symbol's indexed position.
          expect(referenceMap.definition).toEqual({ filePath: targetFilePath, line: 1, column: 1 });

          // (b) imports contains exactly one entry per consumer file.
          expect(referenceMap.imports).toHaveLength(consumerFilePaths.length);
          const importFilePaths = referenceMap.imports.map((imp) => imp.filePath).sort();
          expect(importFilePaths).toEqual([...consumerFilePaths].sort());

          // (c) usages contains at least one entry per consumer file.
          const usageFilePaths = new Set(referenceMap.usages.map((u) => u.filePath));
          for (const consumerFilePath of consumerFilePaths) {
            expect(usageFilePaths.has(consumerFilePath)).toBe(true);
          }

          // (d) calls contains exactly the set of helper functions the
          // target was generated to invoke directly (first level only),
          // resolved by cross-referencing each call's (filePath, line)
          // against the tracked declaration line of each helper.
          const resolvedCallLines = new Set(
            referenceMap.calls.filter((c) => c.filePath === targetFilePath).map((c) => c.line),
          );
          const expectedCallLines = new Set(calledHelpers.map((h) => helperLineByName.get(h.name)!));
          expect(resolvedCallLines).toEqual(expectedCallLines);
          expect(referenceMap.calls).toHaveLength(calledHelpers.length);

          // (e) dependents contains exactly the same set of consumer file
          // paths as derived from imports.
          expect(new Set(referenceMap.dependents)).toEqual(new Set(consumerFilePaths));
        },
      ),
      // Real filesystem I/O (temp dir + target/consumer file writes + a
      // full indexing pass + reference analysis + cleanup) happens on
      // every iteration, same tradeoff documented on the other
      // real-fs-backed property tests in this suite (see
      // indexer.property.test.ts / incremental.property.test.ts): 25 runs
      // across 0-4 helpers and 0-4 consumer files still covers a wide
      // range of shapes (including the empty-helpers/empty-consumers
      // corners) without making the suite slow.
      { numRuns: 25 },
    );
  });
});
