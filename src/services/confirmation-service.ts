/**
 * Confirmation Service.
 *
 * Discoverable, single-module reference point for every user-facing
 * confirmation flow in Pluvianidae (requirements.md 11.3, 11.4, 11.6). See
 * design.md's component list — `services/confirmation-service.ts` is named
 * there as the place that "centralizes all user confirmation flows".
 *
 * ## Why this is a re-export layer, not a merged implementation
 *
 * By the time this module was introduced, five independent, already-working
 * confirmation flows existed, each following the same house pattern
 * (an injectable `I*ConfirmationPrompt`-style interface + a default
 * `VsCode*` implementation that lazily `require('vscode')`s so the rest of
 * the module stays unit-testable without a VS Code extension host):
 *
 *   - `services/bedrock-client.ts` — `IConfirmationPrompt` /
 *     `VsCodeConfirmationPrompt`: confirms transmitting files/code snippets
 *     to Amazon Bedrock (11.3, 11.4). Wired into every `BedrockClient.query()`
 *     call (Buscador, Generador de README, Explicador de Repositorio).
 *   - `modules/dead-code-detector/fix-confirmation.ts` —
 *     `IFixConfirmationPrompt` / `VsCodeFixConfirmationPrompt`: confirms
 *     applying a single line-level auto-fix (4.4, 11.6). Wired into
 *     `AutoFixService`.
 *   - `modules/pre-commit-reviewer/secret-detector.ts` —
 *     `ISecretConfirmationPrompt` / `VsCodeSecretConfirmationPrompt` (plus
 *     `SecretCommitGate`): blocks a commit and requires explicit action when
 *     secrets are detected (6.3). Wired into the pre-commit review command.
 *   - `modules/readme-generator/readme-generator.ts` —
 *     `IReadmeConfirmationPrompt` / `VsCodeReadmeConfirmationPrompt`:
 *     confirms writing a generated README draft to disk (7.2, 7.4, 7.7).
 *   - `modules/seed-engine/seed-store.ts` — `ISeedPersistenceConsent` /
 *     `VsCodeSeedPersistenceConsent`: confirms persisting seeds to disk
 *     across sessions (11.7).
 *
 * Each of these has a different data shape (file/snippet lists vs. a
 * line-level fix preview vs. secret findings vs. a README draft/diff vs. a
 * plain yes/no consent) and is already wired into its own working, tested
 * call site. Forcing all five through one literal merged class would mean
 * either collapsing them behind a single `confirm(data: unknown)`-style
 * signature (losing type safety at every call site) or making breaking
 * changes to five already-working modules — for no functional benefit, and
 * with real regression risk. `fix-confirmation.ts` itself documents this
 * exact tradeoff and deliberately defers generalizing.
 *
 * So "centralizing" here means two concrete things instead:
 *
 *   1. Re-exporting every existing confirmation interface/class from this
 *      one module, so a caller (or a future maintainer) can discover and
 *      import all of them from a single place without hunting through five
 *      module directories.
 *   2. Providing the one confirmation flow that requirement 11.6 describes
 *      generically ("al modificar cualquier archivo del Repositorio_Objetivo")
 *      but that didn't yet have a general-purpose (i.e. not
 *      Dead-Code-Detector-specific) implementation: `IFileModificationConfirmation`
 *      / `VsCodeFileModificationConfirmation`, available for any future
 *      module that needs to propose a file change and confirm it before
 *      applying — without bespoke-building yet another one-off prompt.
 */

// ---------------------------------------------------------------------------
// Re-exports — existing confirmation flows, gathered here for discoverability
// ---------------------------------------------------------------------------

/** Bedrock transmission confirmation (requirements.md 11.3, 11.4). */
export { IConfirmationPrompt, VsCodeConfirmationPrompt } from './bedrock-client';

/** Dead Code Detector auto-fix confirmation (requirements.md 4.4, 11.6). */
export {
  IFixConfirmationPrompt,
  VsCodeFixConfirmationPrompt,
} from '../modules/dead-code-detector/fix-confirmation';

/** Commit blocking dialog for detected secrets (requirements.md 6.3). */
export {
  ISecretConfirmationPrompt,
  VsCodeSecretConfirmationPrompt,
  SecretCommitGate,
} from '../modules/pre-commit-reviewer/secret-detector';

/** README draft write confirmation (requirements.md 7.2, 7.4, 7.7). */
export {
  IReadmeConfirmationPrompt,
  VsCodeReadmeConfirmationPrompt,
} from '../modules/readme-generator/readme-generator';

/** Seed persistence-to-disk consent (requirements.md 11.7). */
export {
  ISeedPersistenceConsent,
  VsCodeSeedPersistenceConsent,
} from '../modules/seed-engine/seed-store';

// ---------------------------------------------------------------------------
// New capability — generic file modification confirmation (requirements.md 11.6)
// ---------------------------------------------------------------------------

/**
 * A proposed change to a single file, shown to the user for review before
 * it is applied. `preview` is a before/after or diff-style rendering of the
 * change — enough for the confirmation dialog to show exactly what will
 * change, per requirements.md 11.6 ("mostrar los cambios propuestos y
 * solicitar confirmación del Usuario antes de aplicar la modificación").
 *
 * This is intentionally generic (unlike `fix-confirmation.ts`'s
 * `ProposedFix`, which is scoped to `DeadCodeFinding`s and their
 * line-level preview shape) so any future module can describe an arbitrary
 * file change without needing its own bespoke confirmation prompt.
 */
export interface FileModificationProposal {
  filePath: string;
  /** Human-readable summary of what will change. */
  description: string;
  /** Before/after or diff-style preview of the proposed change. */
  preview: string;
}

/**
 * Injectable abstraction over the confirmation dialog shown before applying
 * a generic file modification (requirements.md 11.6). The default
 * implementation uses `vscode.window.showWarningMessage`; tests supply a
 * stub so the flow can be exercised without a real VS Code UI. Mirrors the
 * shape of `IConfirmationPrompt` / `IFixConfirmationPrompt` /
 * `IReadmeConfirmationPrompt` / `ISecretConfirmationPrompt`.
 */
export interface IFileModificationConfirmation {
  /** Resolves to `true` if the user confirms applying `proposal`, `false` if they reject it. */
  confirmModification(proposal: FileModificationProposal): Promise<boolean>;
}

/**
 * Default confirmation prompt: shows the proposal's description and preview
 * via `vscode.window.showWarningMessage`, with "Aplicar" / "Cancelar"
 * actions. Dismissing the dialog (e.g. pressing Escape) is treated as
 * rejection, same as every other `VsCode*ConfirmationPrompt` in this
 * codebase.
 */
export class VsCodeFileModificationConfirmation implements IFileModificationConfirmation {
  async confirmModification(proposal: FileModificationProposal): Promise<boolean> {
    // Imported lazily so this module (and the rest of this file's pure
    // logic) can be loaded and unit tested without a VS Code extension
    // host; only this default prompt implementation touches `vscode`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    const message =
      `Pluvianidae propone modificar "${proposal.filePath}":\n\n` +
      `${proposal.description}\n\n${proposal.preview}`;

    const APPLY = 'Aplicar';
    const CANCEL = 'Cancelar';
    const selection = await vscode.window.showWarningMessage(message, { modal: true }, APPLY, CANCEL);
    return selection === APPLY;
  }
}
