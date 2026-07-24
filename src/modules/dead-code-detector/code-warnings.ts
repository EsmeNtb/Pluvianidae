/**
 * Commented-code and duplicate-code detection for the Detector de Código No
 * Utilizado (`modules/dead-code-detector/`).
 *
 * Populates `DeadCodeReport.warnings` (task 7.1 leaves it as `[]`) with
 * `CodeWarning` entries per requirements.md 4.3: a block of 3+ consecutive
 * commented lines, or a block of 5+ lines with ≥80% similarity to another
 * block anywhere in the repository, is reported as a warning separate from
 * the main `DeadCodeFinding`s.
 *
 * `CodeWarning` (design.md > "6. Detector de Código No Utilizado") has no
 * `confidence` field, unlike `DeadCodeFinding`. Per requirements.md 4.3
 * ("con nivel de confianza 'bajo'"), confidence "bajo" is therefore treated
 * as an architectural constant for every `CodeWarning` this module produces
 * — implicit in the type itself rather than a literal field — rather than
 * inventing a field not present in design.md's shape.
 *
 * ## Commented-code detection
 *
 * A line-based scan (not a full tokenizer) classifies each line as
 * "commented" if, after trimming, it starts with `//`, or sits entirely
 * inside an open `/* ... *\/` block comment (including its opening/closing
 * lines, as long as nothing but the comment markers share that line).
 * Consecutive commented lines are grouped into runs; runs of 3+ lines
 * become a `CodeWarning`.
 *
 * Known limitation (documented per the task, not fixed for MVP): this
 * cannot distinguish "commented-out dead code" from legitimate
 * documentation (JSDoc blocks, license headers, etc.) — any 3+ line
 * comment run is flagged uniformly, which may produce false positives from
 * a "dead code" standpoint but is compliant with the literal requirement
 * ("bloque de 3 o más líneas consecutivas comentadas").
 *
 * ## Duplicate-code detection
 *
 * Per the requirement's literal wording ("bloque de 5 o más líneas"), this
 * uses fixed-size 5-line sliding windows (not variable-length maximal
 * regions) as a pragmatic MVP approximation. For each file, every window of
 * 5 consecutive non-blank lines is a candidate; windows made up entirely of
 * comment lines are skipped (already covered by commented-code detection).
 * Two windows are considered duplicates when at least 4 of their 5 lines
 * (after trimming) are exactly equal at the same relative position
 * (matching lines / 5 ≥ 0.8).
 *
 * Comparing every window against every other window is O(n²) in the total
 * number of eligible windows across the repository — an accepted MVP
 * limitation given hackathon scope. A cheap pre-filter buckets windows by
 * their total trimmed character length (rounded to the nearest 20
 * characters) and only compares windows within the same bucket, since a
 * ≥80% line-level match implies very similar total length. This is a
 * documented heuristic: two windows that would otherwise match but happen
 * to straddle a bucket boundary could be missed.
 *
 * Overlapping windows within the same file (e.g. lines 10-14 vs. 11-15,
 * which trivially share 4 of 5 lines because they're the same sliding
 * block shifted by one line) are never compared — that would flag ordinary
 * window overlap as "duplication" rather than genuine copy-pasted code.
 *
 * Once a pair of windows is matched, both are marked "consumed" so neither
 * participates in further matches. This keeps a single duplicate *region*
 * (which spans many overlapping 5-line windows) from producing a flood of
 * near-identical warnings, and ensures a given duplicate pair is reported
 * exactly once (as one `CodeWarning` with `duplicateLocation` pointing at
 * the other occurrence), never twice.
 */

import { CodeWarning } from './dead-code-detector';

/** Minimum length (in lines) of a consecutive commented-line run to report. */
const MIN_COMMENTED_RUN_LENGTH = 3;

/** Fixed window size (in lines) used for duplicate-code detection. */
const DUPLICATE_WINDOW_SIZE = 5;

/** Minimum fraction of matching lines (at the same relative position) to call two windows duplicates. */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

/** Bucket width (in characters) used to pre-filter window comparisons by total length. */
const LENGTH_BUCKET_SIZE = 20;

export interface FileSource {
  filePath: string;
  sourceText: string;
}

// ---------------------------------------------------------------------------
// Commented-code detection
// ---------------------------------------------------------------------------

/**
 * Scans `sourceText` line by line and returns one `CodeWarning` per run of
 * `MIN_COMMENTED_RUN_LENGTH`+ consecutive commented lines. See the
 * module-level doc comment for the line classification rules and known
 * limitations.
 */
export function detectCommentedCodeWarnings(filePath: string, sourceText: string): CodeWarning[] {
  const lines = sourceText.split(/\r?\n/);
  const commentFlags = classifyCommentedLines(lines);
  const warnings: CodeWarning[] = [];

  let runStart = -1;
  for (let i = 0; i <= commentFlags.length; i++) {
    const isCommented = i < commentFlags.length && commentFlags[i];
    if (isCommented) {
      if (runStart === -1) {
        runStart = i;
      }
    } else if (runStart !== -1) {
      const runLength = i - runStart;
      if (runLength >= MIN_COMMENTED_RUN_LENGTH) {
        const startLine = runStart + 1;
        const endLine = i;
        warnings.push({
          type: 'commented-code',
          filePath,
          startLine,
          endLine,
          description: `Se encontraron ${runLength} líneas consecutivas comentadas (líneas ${startLine}-${endLine}); podría tratarse de código muerto comentado.`,
        });
      }
      runStart = -1;
    }
  }

  return warnings;
}

/**
 * Classifies each line of `lines` as "commented" (true) or not (false).
 * A line is commented if, after trimming, it starts with `//`, or is
 * entirely consumed by an open `/* ... *\/` block comment. Lines that mix
 * code with a comment marker (e.g. a block comment closing mid-line
 * followed by code) are treated as not-fully-commented, which naturally
 * breaks a run rather than extending it.
 */
function classifyCommentedLines(lines: string[]): boolean[] {
  const flags: boolean[] = new Array(lines.length);
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (inBlockComment) {
      const closeIdx = trimmed.indexOf('*/');
      if (closeIdx === -1) {
        flags[i] = true;
        continue;
      }
      const after = trimmed.slice(closeIdx + 2).trim();
      flags[i] = after.length === 0;
      inBlockComment = false;
      continue;
    }

    if (trimmed.length === 0) {
      flags[i] = false;
    } else if (trimmed.startsWith('//')) {
      flags[i] = true;
    } else if (trimmed.startsWith('/*')) {
      const closeIdx = trimmed.indexOf('*/', 2);
      if (closeIdx === -1) {
        flags[i] = true;
        inBlockComment = true;
      } else {
        const after = trimmed.slice(closeIdx + 2).trim();
        flags[i] = after.length === 0;
      }
    } else {
      flags[i] = false;
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Duplicate-code detection
// ---------------------------------------------------------------------------

interface DuplicateWindow {
  filePath: string;
  startLine: number;
  endLine: number;
  trimmedLines: string[];
  totalLength: number;
  consumed: boolean;
}

/**
 * Scans every file in `files` for fixed-size 5-line duplicate blocks (see
 * the module-level doc comment) and returns one `CodeWarning` per detected
 * duplicate pair, with `duplicateLocation` pointing at the other
 * occurrence. Each pair is reported exactly once.
 */
export function detectDuplicateCodeWarnings(files: readonly FileSource[]): CodeWarning[] {
  const windows = collectEligibleWindows(files);
  const buckets = new Map<number, DuplicateWindow[]>();
  for (const window of windows) {
    const bucketKey = Math.round(window.totalLength / LENGTH_BUCKET_SIZE);
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.push(window);
    } else {
      buckets.set(bucketKey, [window]);
    }
  }

  const warnings: CodeWarning[] = [];

  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i];
      if (a.consumed) {
        continue;
      }
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j];
        if (b.consumed) {
          continue;
        }
        if (a.filePath === b.filePath && rangesOverlap(a, b)) {
          continue;
        }
        const similarity = computeSimilarity(a.trimmedLines, b.trimmedLines);
        if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
          a.consumed = true;
          b.consumed = true;
          warnings.push({
            type: 'duplicate-code',
            filePath: a.filePath,
            startLine: a.startLine,
            endLine: a.endLine,
            description: `Este bloque de ${DUPLICATE_WINDOW_SIZE} líneas es ${Math.round(similarity * 100)}% similar a otro bloque en "${b.filePath}" (líneas ${b.startLine}-${b.endLine}).`,
            duplicateLocation: { filePath: b.filePath, startLine: b.startLine, endLine: b.endLine },
          });
          break;
        }
      }
    }
  }

  return warnings;
}

/** Builds every eligible fixed-size window across all files, in a stable, deterministic order. */
function collectEligibleWindows(files: readonly FileSource[]): DuplicateWindow[] {
  const windows: DuplicateWindow[] = [];

  for (const file of files) {
    const lines = file.sourceText.split(/\r?\n/);
    const commentFlags = classifyCommentedLines(lines);

    for (let start = 0; start + DUPLICATE_WINDOW_SIZE <= lines.length; start++) {
      const end = start + DUPLICATE_WINDOW_SIZE;
      const rawSlice = lines.slice(start, end);
      const trimmedLines = rawSlice.map((line) => line.trim());

      const hasBlankLine = trimmedLines.some((line) => line.length === 0);
      if (hasBlankLine) {
        continue;
      }
      const allComments = commentFlags.slice(start, end).every(Boolean);
      if (allComments) {
        continue;
      }

      const totalLength = trimmedLines.reduce((sum, line) => sum + line.length, 0);
      windows.push({
        filePath: file.filePath,
        startLine: start + 1,
        endLine: end,
        trimmedLines,
        totalLength,
        consumed: false,
      });
    }
  }

  return windows;
}

function rangesOverlap(a: DuplicateWindow, b: DuplicateWindow): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function computeSimilarity(linesA: string[], linesB: string[]): number {
  let matches = 0;
  const length = Math.min(linesA.length, linesB.length);
  for (let i = 0; i < length; i++) {
    if (linesA[i] === linesB[i]) {
      matches++;
    }
  }
  return matches / DUPLICATE_WINDOW_SIZE;
}
