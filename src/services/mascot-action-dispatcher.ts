/**
 * Mascot Action Dispatcher (`src/services/mascot-action-dispatcher.ts`).
 *
 * Implements design.md > "Componente 3: `MascotActionDispatcher`": the
 * single place that translates each already-validated `MascotAction`
 * (mascota → extensión, see `shared/mascot-actions.ts`) into exactly one
 * VS Code command or local effect on `DesktopMascotManager`, via a
 * static mapping table — never dynamic code execution, and never string
 * interpolation of `action.action` into a command id.
 *
 * design.md > "Menú contextual y allowlist de acciones" defines the
 * exact table this module implements:
 *
 * ```
 * 'analyze-repository'  -> vscode.commands.executeCommand('pluvianidae.explainRepository')
 * 'precommit-review'    -> vscode.commands.executeCommand('pluvianidae.preCommitReview')
 * 'show-seed-basket'    -> vscode.commands.executeCommand('pluvianidae.seedBasket.focus')
 * 'mute-messages'       -> desktopMascotManager silencia bubbles localmente (ver nota abajo)
 * 'hide-mascot'         -> desktopMascotManager.hide()
 * 'close-mascot'        -> desktopMascotManager.stop()
 * ```
 *
 * ## Scope note for `mute-messages` (tasks.md 12.1)
 *
 * design.md describes `mute-messages` as "desktopMascotManager silencia
 * bubbles localmente ... no requiere comando VS Code". As of this task,
 * `DesktopMascotManager` (`desktop-mascot-manager.ts`) exposes no
 * mute/silence method or flag at all, and adding one to that class is
 * explicitly out of scope here — this task is scoped to
 * `mascot-action-dispatcher.ts` only. So for now, `mute-messages` simply
 * does not invoke any VS Code command (matching the table above exactly:
 * there is no command on that row) and only logs that the action was
 * received. Wiring an actual local mute effect into
 * `DesktopMascotManager` is left to a future task.
 *
 * ## Defense in depth
 *
 * `dispatch()` never trusts its caller: it re-validates `action` with
 * `isMascotAction` before doing anything, exactly like every other
 * boundary in this feature (`LocalMascotServer.broadcast`,
 * `DesktopMascotManager.send`). The mapping itself is a literal `switch`
 * over the six known string literals plus an explicit `default` case —
 * there is no code path here that could ever construct a command id by
 * concatenating `action.action` into a string.
 */

import { MascotAction, isMascotAction } from '../../shared/mascot-actions';
import { DesktopMascotManager } from './desktop-mascot-manager';

// ---------------------------------------------------------------------------
// Public interface (design.md > "Componente 3: MascotActionDispatcher")
// ---------------------------------------------------------------------------

export interface MascotActionDispatcher {
  /**
   * Re-validates `action` with `isMascotAction` and, if valid, executes
   * exactly the VS Code command or `DesktopMascotManager` effect defined
   * for it by the static mapping table. An invalid `action` (should
   * never happen if the caller already validated, but never trusted) or
   * one outside the allowlist is logged and dropped; this method never
   * throws.
   */
  dispatch(action: MascotAction): Promise<void>;
}

/**
 * Injectable seam for `vscode.commands.executeCommand`, matching this
 * codebase's existing pattern of an injectable default implementation
 * that lazily `require('vscode')`s (see `confirmation-service.ts`,
 * `bedrock-client.ts`, `seed-basket-view.ts`, `mascot-controller.ts`)
 * plus a caller-supplied test double. Tests inject a plain mock function
 * here instead of mocking the whole `vscode` module.
 */
export type ExecuteVsCodeCommand = (command: string, ...args: unknown[]) => Thenable<unknown>;

export interface MascotActionDispatcherDeps {
  /** Used for the `hide-mascot` / `close-mascot` local effects. */
  desktopMascotManager: DesktopMascotManager;
  /**
   * Test seam: overrides the default `vscode.commands.executeCommand`.
   * Defaults to a lazily-`require('vscode')`d implementation, so this
   * module (and every caller that injects its own function) never needs
   * a real VS Code extension host to be unit tested.
   */
  executeCommand?: ExecuteVsCodeCommand;
}

/** Creates a `MascotActionDispatcher`, following this codebase's `create*` factory convention (see `createLocalMascotServer`). */
export function createMascotActionDispatcher(deps: MascotActionDispatcherDeps): MascotActionDispatcher {
  return new VsCodeMascotActionDispatcher(deps.desktopMascotManager, deps.executeCommand ?? defaultExecuteCommand);
}

// ---------------------------------------------------------------------------
// Command id constants (the only place these string literals live)
// ---------------------------------------------------------------------------

const EXPLAIN_REPOSITORY_COMMAND = 'pluvianidae.explainRepository';
const PRE_COMMIT_REVIEW_COMMAND = 'pluvianidae.preCommitReview';
const SEED_BASKET_FOCUS_COMMAND = 'pluvianidae.seedBasket.focus';

// ---------------------------------------------------------------------------
// VsCodeMascotActionDispatcher
// ---------------------------------------------------------------------------

class VsCodeMascotActionDispatcher implements MascotActionDispatcher {
  constructor(
    private readonly desktopMascotManager: DesktopMascotManager,
    private readonly executeCommand: ExecuteVsCodeCommand
  ) {}

  async dispatch(action: MascotAction): Promise<void> {
    // Defense in depth: never trust the caller, even though
    // `LocalMascotServer` already validates every `POST /actions` body
    // with `isMascotAction` before invoking any registered handler.
    if (!isMascotAction(action)) {
      // eslint-disable-next-line no-console
      console.error('[Pluvianidae] MascotActionDispatcher.dispatch() recibió un MascotAction inválido; descartado.', action);
      return;
    }

    // Static mapping table (design.md > "Menú contextual y allowlist de
    // acciones"), a literal switch over the six known string literals.
    // Never build a command id by concatenating `action.action` into a
    // string — every case below invokes a hardcoded literal command id.
    switch (action.action) {
      case 'analyze-repository':
        await this.executeCommand(EXPLAIN_REPOSITORY_COMMAND);
        return;

      case 'precommit-review':
        await this.executeCommand(PRE_COMMIT_REVIEW_COMMAND);
        return;

      case 'show-seed-basket':
        await this.executeCommand(SEED_BASKET_FOCUS_COMMAND);
        return;

      case 'mute-messages':
        // No VS Code command on this row of the table (see this
        // module's doc comment > "Scope note for mute-messages"). Local
        // bubble-silencing in `DesktopMascotManager` is deliberately not
        // implemented yet; only log receipt of the action for now.
        // eslint-disable-next-line no-console
        console.error('[Pluvianidae] MascotActionDispatcher: acción "mute-messages" recibida (aún sin efecto local implementado).');
        return;

      case 'hide-mascot':
        await this.desktopMascotManager.hide();
        return;

      case 'close-mascot':
        await this.desktopMascotManager.stop();
        return;

      default:
        // Additional defense in depth: `isMascotAction` above should
        // already have rejected anything outside the allowlist, so this
        // branch is unreachable in practice — but it exists explicitly
        // so a future, incorrectly-widened `MascotAction` type can never
        // silently fall through to executing nothing more dangerous than
        // a log line.
        // eslint-disable-next-line no-console
        console.error('[Pluvianidae] MascotActionDispatcher.dispatch() recibió una acción fuera de la allowlist; descartada.', action);
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Default vscode.commands.executeCommand seam
// ---------------------------------------------------------------------------

/**
 * Default `ExecuteVsCodeCommand`, lazily `require('vscode')`d so this
 * module stays importable (and every other export here unit-testable)
 * without a real VS Code extension host — only this function ever
 * touches `vscode` directly.
 */
function defaultExecuteCommand(command: string, ...args: unknown[]): Thenable<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode: typeof import('vscode') = require('vscode');
  return vscode.commands.executeCommand(command, ...args);
}
