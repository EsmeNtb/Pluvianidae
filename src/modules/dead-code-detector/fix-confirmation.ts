/**
 * Confirmation workflow for the Detector de Código No Utilizado's
 * auto-fixes (`modules/dead-code-detector/`). See requirements.md 4.4
 * ("presentar las correcciones automáticas como propuestas y solicitar
 * confirmación del Usuario antes de aplicar cambios") and requirements.md
 * 11.6 ("mostrar los cambios propuestos y solicitar confirmación del
 * Usuario antes de aplicar la modificación").
 *
 * This module is scoped to the Dead Code Detector's `DeadCodeFinding`s
 * only. Requirement 11.6 is phrased generically ("cualquier archivo del
 * Repositorio_Objetivo"), and other modules (e.g. the README generator,
 * task 11) will eventually need an equivalent "propose changes → confirm
 * → apply" flow for their own file modifications. A shared
 * `IConfirmationPrompt`-for-file-changes abstraction could be extracted
 * later if/when that overlap materializes, but this task intentionally
 * does not build that generalization prematurely — see
 * `services/bedrock-client.ts`'s `IConfirmationPrompt` for a similarly
 * shaped but semantically different confirmation (yes/no on a batch of
 * files/snippets being *transmitted*, not a specific *edit* to apply),
 * which is why a distinct interface is defined here rather than reusing it.
 *
 * ## What "eliminar" and "comentar" mean per finding type
 *
 * `DeadCodeFinding` only carries a single 1-indexed `line` number (no end
 * line / column range), mirroring the line-level granularity already used
 * throughout `dead-code-detector.ts` (e.g. "Multi-line import statements
 * are not specially handled — only the single line reported by
 * `ImportEntry.line` is excluded"). This module follows the same
 * documented MVP simplification:
 *
 *   - `'unused-import'`, `'unused-variable'`, `'unused-parameter'`,
 *     `'unused-function'`: `'eliminar'` proposes deleting the single line
 *     at `finding.line` in its entirety; `'comentar'` proposes prefixing
 *     that same line with a `// ` comment marker instead (preserving
 *     indentation) rather than deleting it. For `'unused-function'` this
 *     only removes the function's first line (its signature), not its
 *     whole body — a known MVP limitation, consistent with `findings` not
 *     carrying an `endLine`. For `'unused-parameter'`, likewise, the whole
 *     signature line is affected rather than surgically removing just the
 *     parameter token — a documented simplification for the same reason.
 *   - `'orphan-file'`: `'eliminar'` proposes deleting the entire file
 *     (there is no single "line" to remove — the whole file is dead).
 *     `'comentar'` has no sensible meaning for a whole file and is treated
 *     defensively (see `proposeFix`'s inline comment) — this combination
 *     does not occur today, since `detectOrphanFiles` always assigns
 *     `suggestedAction: 'revisar-manualmente'`.
 *   - `'revisar-manualmente'` (any finding type): no automatic fix is
 *     proposed at all; `proposeFix` returns `undefined` so callers never
 *     offer an "apply" action for these findings.
 */

import * as fs from 'fs/promises';
import { DeadCodeFinding } from './dead-code-detector';

// ---------------------------------------------------------------------------
// Proposed fix shape
// ---------------------------------------------------------------------------

/**
 * A concrete, user-reviewable proposal for fixing a single
 * `DeadCodeFinding`. `preview` is a minimal before/after style rendering of
 * the affected line(s) (not a full unified diff), enough for the
 * confirmation dialog to show exactly what will change per requirements.md
 * 11.6.
 */
export interface ProposedFix {
  finding: DeadCodeFinding;
  filePath: string;
  /** Human-readable summary of what will change (defaults to the finding's own description). */
  description: string;
  /** Before/after style preview of the affected line(s), or the whole-file deletion notice for orphan files. */
  preview: string;
}

/**
 * Outcome of `IAutoFixService.applyFix`. Distinguishes a user rejection
 * from an actual failure, mirroring `BedrockClient`'s pattern of giving
 * cancellation its own distinct signal (there,
 * `BedrockTransmissionCancelledError`) rather than conflating "the user
 * said no" with "something went wrong".
 */
export type FixOutcome = 'applied' | 'rejected' | 'error';

export interface FixResult {
  outcome: FixOutcome;
  /** Present only when `outcome === 'error'`: a human-readable failure reason. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Confirmation prompt (injectable, mirrors bedrock-client.ts's
// IConfirmationPrompt / VsCodeConfirmationPrompt pattern)
// ---------------------------------------------------------------------------

/**
 * Injectable abstraction over the confirmation dialog shown before applying
 * a single auto-fix (requirements.md 4.4, 11.6). The default implementation
 * uses `vscode.window.showWarningMessage`; tests supply a stub so the flow
 * can be exercised without a real VS Code UI.
 */
export interface IFixConfirmationPrompt {
  /** Resolves to `true` if the user confirms applying `fix`, `false` if they reject it. */
  confirmFix(fix: ProposedFix): Promise<boolean>;
}

/**
 * Default confirmation prompt: shows the finding's description and the
 * proposed before/after preview via `vscode.window.showWarningMessage`,
 * with "Aplicar" / "Rechazar" actions. Dismissing the dialog (e.g. pressing
 * Escape) is treated as rejection, same as `VsCodeConfirmationPrompt` in
 * `bedrock-client.ts`.
 */
export class VsCodeFixConfirmationPrompt implements IFixConfirmationPrompt {
  async confirmFix(fix: ProposedFix): Promise<boolean> {
    // Imported lazily so this module (and the rest of this file's pure
    // logic) can be loaded and unit tested without a VS Code extension
    // host; only this default prompt implementation touches `vscode`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    const message =
      `Pluvianidae propone la siguiente corrección en "${fix.filePath}":\n\n` +
      `${fix.description}\n\n${fix.preview}`;

    const APPLY = 'Aplicar';
    const REJECT = 'Rechazar';
    const selection = await vscode.window.showWarningMessage(message, { modal: true }, APPLY, REJECT);
    return selection === APPLY;
  }
}

// ---------------------------------------------------------------------------
// File editing (injectable, mirrors DeadCodeDetector's IFileContentReader
// pattern, extended with write/delete since fixes mutate files)
// ---------------------------------------------------------------------------

/**
 * Injectable abstraction over the filesystem operations an auto-fix needs.
 * Kept narrow (read/write/delete) rather than exposing all of `fs`, so
 * `AutoFixService` is unit-testable without touching the real filesystem
 * in most test cases.
 */
export interface IFileEditor {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
}

export class FsFileEditor implements IFileEditor {
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async deleteFile(filePath: string): Promise<void> {
    await fs.rm(filePath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// AutoFixService
// ---------------------------------------------------------------------------

/**
 * Proposes and applies auto-fixes for `DeadCodeFinding`s, gating every
 * application behind explicit user confirmation (requirements.md 4.4,
 * 11.6). `proposeFix` is async (unlike the initial interface sketch) since
 * building an accurate before/after `preview` requires reading the
 * finding's current file content — there is no other cached source of
 * truth for the affected line at this point in the pipeline.
 */
export interface IAutoFixService {
  /** Returns `undefined` when `finding.suggestedAction === 'revisar-manualmente'` — no fix is offered. */
  proposeFix(finding: DeadCodeFinding): Promise<ProposedFix | undefined>;
  /** Confirms with the user first; only mutates the file if confirmed. */
  applyFix(fix: ProposedFix): Promise<FixResult>;
}

export class AutoFixService implements IAutoFixService {
  constructor(
    private readonly fileEditor: IFileEditor = new FsFileEditor(),
    private readonly confirmationPrompt: IFixConfirmationPrompt = new VsCodeFixConfirmationPrompt(),
  ) {}

  async proposeFix(finding: DeadCodeFinding): Promise<ProposedFix | undefined> {
    if (finding.suggestedAction === 'revisar-manualmente') {
      return undefined;
    }

    if (finding.type === 'orphan-file') {
      if (finding.suggestedAction === 'comentar') {
        // Not a meaningful action for a whole file, and unreachable today
        // since `detectOrphanFiles` always assigns 'revisar-manualmente'.
        // Guarded defensively rather than producing a nonsensical fix.
        return undefined;
      }
      return {
        finding,
        filePath: finding.filePath,
        description: finding.description,
        preview: `- (archivo completo)\n+ (el archivo "${finding.filePath}" será eliminado)`,
      };
    }

    const content = await this.fileEditor.readFile(finding.filePath);
    const lines = splitLines(content);
    const lineIndex = finding.line - 1;
    const originalLine = lines[lineIndex] ?? '';

    const replacementLine = finding.suggestedAction === 'eliminar' ? '(línea eliminada)' : commentOutLine(originalLine);

    return {
      finding,
      filePath: finding.filePath,
      description: finding.description,
      preview: `- ${originalLine}\n+ ${replacementLine}`,
    };
  }

  async applyFix(fix: ProposedFix): Promise<FixResult> {
    const confirmed = await this.confirmationPrompt.confirmFix(fix);
    if (!confirmed) {
      // Mirrors BedrockClient's BedrockTransmissionCancelledError intent:
      // rejection is reported distinctly, and nothing is modified.
      return { outcome: 'rejected' };
    }

    try {
      await this.performFix(fix);
      return { outcome: 'applied' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { outcome: 'error', message };
    }
  }

  private async performFix(fix: ProposedFix): Promise<void> {
    const { finding } = fix;

    if (finding.type === 'orphan-file' && finding.suggestedAction === 'eliminar') {
      await this.fileEditor.deleteFile(fix.filePath);
      return;
    }

    const content = await this.fileEditor.readFile(fix.filePath);
    const lines = splitLines(content);
    const lineIndex = finding.line - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(
        `La línea ${finding.line} ya no existe en "${fix.filePath}"; el archivo pudo haber cambiado desde que se propuso la corrección.`,
      );
    }

    if (finding.suggestedAction === 'eliminar') {
      lines.splice(lineIndex, 1);
    } else if (finding.suggestedAction === 'comentar') {
      lines[lineIndex] = commentOutLine(lines[lineIndex]);
    }

    // Lines are rejoined with '\n' regardless of the file's original line
    // ending style — a documented MVP simplification, consistent with this
    // detector's other line-based text manipulations.
    await this.fileEditor.writeFile(fix.filePath, lines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Prefixes `line` with a `// ` comment marker, preserving its leading indentation. */
function commentOutLine(line: string): string {
  const match = /^(\s*)(.*)$/.exec(line);
  const indent = match ? match[1] : '';
  const rest = match ? match[2] : line;
  return `${indent}// ${rest}`;
}
