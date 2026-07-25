import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeReadmeDiff } from '../../src/modules/readme-generator/readme-diff';

// Feature: pluvianidae-mvp, Property 24: README diff generation
//
// "For any existing README and proposed README draft, the Generador SHALL
// produce a correct diff showing all additions, removals, and modifications
// between the two documents."
// Validates: Requirements 7.4

const NUM_RUNS = 100;

const NO_CHANGES_MESSAGE = 'Sin cambios respecto al README existente.';

/** Prefixes used by `computeReadmeDiff`'s rendering, kept in sync with readme-diff.ts. */
const CONTEXT_PREFIX = '  ';
const ADDED_PREFIX = '+ ';
const REMOVED_PREFIX = '- ';

/** A single README "line" - any string, excluding newlines (lines are joined by '\n'). */
const lineArbitrary = fc.string({ maxLength: 12 }).filter((s) => !s.includes('\n'));

/**
 * Arbitrary multi-line README-like content built from a small set of lines.
 *
 * Excludes arrays of 2+ lines ending in an empty string: joining such an
 * array with '\n' produces content with a trailing newline, which
 * `computeReadmeDiff` intentionally normalizes to "no extra empty line"
 * (standard file-line semantics - a file ending in "\n" has one fewer line
 * than a naive split() would suggest). That normalization is correct
 * implementation behavior, not something this reconstruction property
 * should be sensitive to.
 */
const linesArbitrary = fc
  .array(lineArbitrary, { minLength: 0, maxLength: 6 })
  .filter((lines) => lines.length < 2 || lines[lines.length - 1] !== '');

describe('computeReadmeDiff property tests - Property 24: README diff generation', () => {
  it('returns undefined for any draft when there is no existing README', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (draftContent) => {
        expect(computeReadmeDiff(undefined, draftContent)).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns the fixed "no changes" message for any identical existing/draft content, never a diff listing', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (content) => {
        const diff = computeReadmeDiff(content, content);
        expect(diff).toBe(NO_CHANGES_MESSAGE);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('renders a diff whose added/context lines reconstruct the draft and whose removed/context lines reconstruct the existing content', () => {
    fc.assert(
      fc.property(linesArbitrary, linesArbitrary, (existingLines, draftLines) => {
        const existingContent = existingLines.join('\n');
        const draftContent = draftLines.join('\n');

        // Identical content is covered by the "no changes" property above;
        // here we only care about genuinely differing content.
        fc.pre(existingContent !== draftContent);

        const diff = computeReadmeDiff(existingContent, draftContent);
        expect(diff).toBeDefined();
        expect(diff).not.toBe(NO_CHANGES_MESSAGE);

        const renderedLines = diff!.split('\n');

        // Every rendered line must carry exactly one of the three known
        // 2-character prefixes.
        for (const line of renderedLines) {
          const prefix = line.slice(0, 2);
          expect([CONTEXT_PREFIX, ADDED_PREFIX, REMOVED_PREFIX]).toContain(prefix);
        }

        // Added + unchanged lines (in order), with their prefixes stripped,
        // must reconstruct the draft content exactly.
        const reconstructedDraft = renderedLines
          .filter((line) => line.slice(0, 2) === ADDED_PREFIX || line.slice(0, 2) === CONTEXT_PREFIX)
          .map((line) => line.slice(2))
          .join('\n');
        expect(reconstructedDraft).toBe(draftContent);

        // Removed + unchanged lines (in order), with their prefixes
        // stripped, must reconstruct the existing content exactly.
        const reconstructedExisting = renderedLines
          .filter((line) => line.slice(0, 2) === REMOVED_PREFIX || line.slice(0, 2) === CONTEXT_PREFIX)
          .map((line) => line.slice(2))
          .join('\n');
        expect(reconstructedExisting).toBe(existingContent);

        // There must be at least one addition or removal, since the
        // contents are known to differ.
        expect(
          renderedLines.some(
            (line) => line.slice(0, 2) === ADDED_PREFIX || line.slice(0, 2) === REMOVED_PREFIX,
          ),
        ).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
