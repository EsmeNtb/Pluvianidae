import { describe, it, expect } from 'vitest';
import {
  detectCommentedCodeWarnings,
  detectDuplicateCodeWarnings,
  FileSource,
} from '../../../src/modules/dead-code-detector/code-warnings';

describe('detectCommentedCodeWarnings', () => {
  it('flags a run of 3+ consecutive commented lines', () => {
    const source = [
      "const a = 1;",
      "// const old = 1;",
      "// const older = 2;",
      "// const oldest = 3;",
      "const b = 2;",
    ].join('\n');

    const warnings = detectCommentedCodeWarnings('/repo/src/file.ts', source);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: 'commented-code',
      filePath: '/repo/src/file.ts',
      startLine: 2,
      endLine: 4,
    });
    expect(warnings[0].duplicateLocation).toBeUndefined();
  });

  it('does not flag a run of 1-2 commented lines (below threshold)', () => {
    const source = ["const a = 1;", "// just one comment", "const b = 2;"].join('\n');

    const warnings = detectCommentedCodeWarnings('/repo/src/file.ts', source);

    expect(warnings).toHaveLength(0);
  });

  it('does not flag a 2-line commented run', () => {
    const source = ["const a = 1;", "// comment one", "// comment two", "const b = 2;"].join('\n');

    const warnings = detectCommentedCodeWarnings('/repo/src/file.ts', source);

    expect(warnings).toHaveLength(0);
  });

  it('flags a block comment spanning 3+ lines', () => {
    const source = ["const a = 1;", "/*", " * old code", " * more old code", "*/", "const b = 2;"].join('\n');

    const warnings = detectCommentedCodeWarnings('/repo/src/file.ts', source);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ startLine: 2, endLine: 5 });
  });
});

describe('detectDuplicateCodeWarnings', () => {
  it('detects a 5+ line duplicate block across two different files with correct duplicateLocation', () => {
    const blockLines = [
      'function computeTotal(items) {',
      '  let total = 0;',
      '  for (const item of items) {',
      '    total += item.price;',
      '  }',
      '  return total;',
      '}',
    ];

    const fileA: FileSource = {
      filePath: '/repo/src/a.ts',
      sourceText: ['export const noop = 1;', ...blockLines].join('\n'),
    };
    const fileB: FileSource = {
      filePath: '/repo/src/b.ts',
      sourceText: [...blockLines, 'export const other = 2;'].join('\n'),
    };

    const warnings = detectDuplicateCodeWarnings([fileA, fileB]);

    const duplicateWarnings = warnings.filter((w) => w.type === 'duplicate-code');
    expect(duplicateWarnings.length).toBeGreaterThanOrEqual(1);

    const warning = duplicateWarnings[0];
    expect(warning.duplicateLocation).toBeDefined();
    // One side should point at fileA, the other at fileB.
    const filePaths = [warning.filePath, warning.duplicateLocation?.filePath];
    expect(filePaths).toContain('/repo/src/a.ts');
    expect(filePaths).toContain('/repo/src/b.ts');
  });

  it('reports a duplicate pair only once, not twice', () => {
    // Exactly DUPLICATE_WINDOW_SIZE (5) lines, so each file contributes a
    // single sliding window and there is exactly one pair to report.
    const blockLines = [
      'function helperOne(x) {',
      '  const y = x + 1;',
      '  console.log(y);',
      '  return y;',
      '}',
    ];

    const fileA: FileSource = { filePath: '/repo/src/a.ts', sourceText: blockLines.join('\n') };
    const fileB: FileSource = { filePath: '/repo/src/b.ts', sourceText: blockLines.join('\n') };

    const warnings = detectDuplicateCodeWarnings([fileA, fileB]);

    // Exactly one CodeWarning should represent this duplicate pair (not one per side).
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe('duplicate-code');
  });

  it('does not flag blocks below the 80% similarity threshold', () => {
    const fileA: FileSource = {
      filePath: '/repo/src/a.ts',
      sourceText: ['const line1 = 1;', 'const line2 = 2;', 'const line3 = 3;', 'const line4 = 4;', 'const line5 = 5;'].join(
        '\n',
      ),
    };
    const fileB: FileSource = {
      filePath: '/repo/src/b.ts',
      sourceText: [
        'const totallyDifferentA = 10;',
        'const totallyDifferentB = 20;',
        'const totallyDifferentC = 30;',
        'const line4 = 4;',
        'const line5 = 5;',
      ].join('\n'),
    };

    const warnings = detectDuplicateCodeWarnings([fileA, fileB]);

    expect(warnings).toHaveLength(0);
  });
});
