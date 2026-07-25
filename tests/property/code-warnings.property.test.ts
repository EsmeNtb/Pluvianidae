import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  detectCommentedCodeWarnings,
  detectDuplicateCodeWarnings,
  FileSource,
} from '../../src/modules/dead-code-detector/code-warnings';

// Feature: pluvianidae-mvp, Property 11: Commented and duplicate code thresholds
//
// "For any code block, the Detector SHALL flag it as a warning if and only
// if it is a commented block of 3 or more consecutive lines OR a block of 5
// or more lines with at least 80% similarity to another block in the
// repository, and all such warnings SHALL have confidence 'bajo'."
// Validates: Requirements 4.3
//
// Note on the "confidence bajo" clause: `CodeWarning` (design.md's shape)
// has no `confidence` field at all - "bajo" is an architectural constant
// implicit in the type itself, not a runtime value. That aspect is
// therefore a type-level guarantee rather than something a runtime property
// check can meaningfully assert, so this file focuses on the two
// substantive, testable thresholds below.

const NUM_RUNS = 100;

describe('Property 11: Commented and duplicate code thresholds', () => {
  describe('commented-code threshold (boundary-exact)', () => {
    it('flags a run of exactly n consecutive commented lines if and only if n >= 3', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 8 }), (n) => {
          const commentLines = Array.from({ length: n }, (_, i) => `// commented line ${i}`);
          const lines = ['const a = 1;', ...commentLines, 'const b = 2;'];
          const source = lines.join('\n');

          const warnings = detectCommentedCodeWarnings('/repo/src/file.ts', source);

          if (n >= 3) {
            expect(warnings).toHaveLength(1);
            expect(warnings[0].type).toBe('commented-code');
            // Run starts right after the leading non-comment line (line 2)
            // and spans exactly n lines.
            expect(warnings[0].startLine).toBe(2);
            expect(warnings[0].endLine).toBe(1 + n);
            expect(warnings[0].endLine - warnings[0].startLine + 1).toBe(n);
          } else {
            expect(warnings).toHaveLength(0);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('duplicate-code threshold (similarity-exact)', () => {
    // Fixed-length tokens (all the same length) at every position, and
    // equal-length "same"/"difA"/"difB" markers, guarantee the two 5-line
    // blocks always have identical total character length regardless of
    // which positions match - so they always fall into the same length
    // bucket used by the implementation's comparison pre-filter, and the
    // only variable left is the actual match/no-match pattern being tested.
    const token = fc.stringMatching(/^[a-z0-9]{3}$/);
    const fiveTokens = fc.array(token, { minLength: 5, maxLength: 5 });

    it('flags two 5-line blocks if and only if at least 4 of 5 lines match at the same position', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 5 }),
          fiveTokens,
          fiveTokens,
          fiveTokens,
          (k, sharedTokens, aTokens, bTokens) => {
            const linesA: string[] = [];
            const linesB: string[] = [];

            for (let i = 0; i < 5; i++) {
              if (i < k) {
                // Identical content at this position in both blocks.
                const shared = `const same_${i}_${sharedTokens[i]} = ${i};`;
                linesA.push(shared);
                linesB.push(shared);
              } else {
                // Distinct content at this position, guaranteed unequal by
                // the differing "difA"/"difB" markers (both length 4, so
                // total line length still matches its A/B counterpart).
                linesA.push(`const difA_${i}_${aTokens[i]} = ${i};`);
                linesB.push(`const difB_${i}_${bTokens[i]} = ${i};`);
              }
            }

            const fileA: FileSource = { filePath: '/repo/src/a.ts', sourceText: linesA.join('\n') };
            const fileB: FileSource = { filePath: '/repo/src/b.ts', sourceText: linesB.join('\n') };

            const warnings = detectDuplicateCodeWarnings([fileA, fileB]);
            const similarity = k / 5;

            if (similarity >= 0.8) {
              expect(warnings).toHaveLength(1);
              expect(warnings[0].type).toBe('duplicate-code');
              expect(warnings[0].duplicateLocation).toBeDefined();
              const filePaths = [warnings[0].filePath, warnings[0].duplicateLocation?.filePath];
              expect(filePaths).toContain('/repo/src/a.ts');
              expect(filePaths).toContain('/repo/src/b.ts');
            } else {
              expect(warnings).toHaveLength(0);
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
