/**
 * README diff generation for the Generador de README (`modules/readme-generator/`).
 *
 * Implements the `ReadmeDiffComputer` integration point left as a
 * `noopReadmeDiffComputer` placeholder by `readme-generator.ts` (task 11.1),
 * per requirements.md 7.4 ("mostrar las diferencias entre el README
 * existente y el borrador propuesto como parte de la propuesta de
 * confirmación"). This mirrors the `dead-code-detector.ts` /
 * `code-warnings.ts` and `pre-commit-reviewer.ts` / `secret-detector.ts`
 * split: the main module defines the hook, this file implements it, and no
 * changes to `generateDraft()`'s logic are required — only wiring a real
 * `ReadmeDiffComputer` into `ReadmeGenerator`'s constructor.
 *
 * ## Diffing approach
 *
 * Uses the `diff` npm package (`Diff.diffLines`), a small, widely-used,
 * actively-maintained library for text diffing, rather than hand-rolling an
 * LCS-based line diff. Diffing is a well-solved problem — reusing a
 * battle-tested implementation is more correct and robust for arbitrary
 * README text (including edge cases like trailing newlines, empty files,
 * and large documents) than a bespoke MVP algorithm would be.
 *
 * `Diff.diffLines` produces a sequence of `Change` objects, each with a
 * multi-line `value` and `added`/`removed` flags (neither set means
 * unchanged). This module renders that sequence into a simple,
 * unified-diff-like text: every line of an unchanged chunk is prefixed with
 * `  ` (two spaces), every line of an added chunk with `+ `, and every line
 * of a removed chunk with `- `. No context-collapsing is performed for
 * unchanged runs — showing every line is acceptable for MVP scope (per this
 * task's guidance) and keeps the rendering logic simple and predictable.
 *
 * A "modified" line (per requirements.md 7.4's "modificaciones") is not a
 * distinct concept in `diffLines`' output — it naturally appears as a
 * removed line immediately followed by an added line at the same position,
 * which is exactly how line-level modifications are represented by this
 * rendering (and by unified diffs generally).
 */

import * as Diff from 'diff';

/** Prefix used for unchanged (context) lines in the rendered diff. */
const CONTEXT_PREFIX = '  ';
/** Prefix used for added lines in the rendered diff. */
const ADDED_PREFIX = '+ ';
/** Prefix used for removed lines in the rendered diff. */
const REMOVED_PREFIX = '- ';

/**
 * Computes a human-readable diff between `existingContent` and
 * `draftContent`.
 *
 * - Returns `undefined` when there is no existing README to diff against
 *   (`existingContent === undefined`) — nothing to compare, per
 *   `ReadmeDiffComputer`'s contract.
 * - Returns a "no changes" message when both contents are equal, so the
 *   confirmation dialog can still confirm to the user that nothing changed
 *   rather than showing an empty section.
 * - Otherwise returns a unified-diff-like string with one line per input
 *   line, prefixed with `+ ` (addition), `- ` (removal), or `  `
 *   (unchanged). A modification is rendered as a `- ` line immediately
 *   followed by a `+ ` line at the same position.
 */
export function computeReadmeDiff(existingContent: string | undefined, draftContent: string): string | undefined {
  if (existingContent === undefined) {
    return undefined;
  }

  if (existingContent === draftContent) {
    return 'Sin cambios respecto al README existente.';
  }

  const changes = Diff.diffLines(existingContent, draftContent);
  const lines: string[] = [];

  for (const change of changes) {
    // `Diff.diffLines` keeps trailing newlines inside `value`; splitting on
    // "\n" and dropping a resulting empty final element avoids rendering a
    // spurious blank prefixed line for each chunk's trailing newline.
    const chunkLines = change.value.split('\n');
    if (chunkLines.length > 0 && chunkLines[chunkLines.length - 1] === '') {
      chunkLines.pop();
    }

    const prefix = change.added ? ADDED_PREFIX : change.removed ? REMOVED_PREFIX : CONTEXT_PREFIX;
    for (const line of chunkLines) {
      lines.push(`${prefix}${line}`);
    }
  }

  return lines.join('\n');
}
