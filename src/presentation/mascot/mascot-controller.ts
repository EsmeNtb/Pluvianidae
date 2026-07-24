/**
 * Mascota Controller (`presentation/mascot/mascot-controller.ts`).
 *
 * Coordination/state-tracking layer for the Mascota, per design.md > "11.
 * Mascota Controller (`modules/mascot/`)" and requirements.md > Requirement
 * 10 (10.1, 10.6 for this task specifically).
 *
 * ## Division of responsibility
 *
 * This task builds `MascotController` as a thin coordinator: it decides
 * *what* the mascot's visibility/position/animation state should be, and
 * delegates the actual visual work to an injected `IMascotRenderer`. It
 * deliberately does NOT render anything itself:
 *
 *   - The animation queue/timing logic (idle timeout, max-3-second
 *     durations for `analysis-complete`/`celebration`, sequential
 *     processing of simultaneous events per requirements.md 10.7) is task
 *     14.2's responsibility (`animation-engine.ts`).
 *   - The actual CSS/SVG rendering inside a VS Code Webview, and the
 *     non-overlapping corner positioning mandated by requirements.md 10.1
 *     ("sin superponer contenido editable ni controles interactivos"), is
 *     task 14.3's responsibility (`mascot-webview.ts`).
 *
 * `IMascotRenderer` is the injection point those two tasks plug into. This
 * mirrors the established "main module defines the hook, a later task
 * supplies the real implementation" pattern already used elsewhere in this
 * codebase — e.g. `DeadCodeDetector`'s use of `code-warnings.ts` via a
 * narrow function import, `PreCommitReviewer`'s `ISecretDetector` hook, and
 * `ReadmeGenerator`'s `IReadmeDiffComputer` hook. Until 14.2/14.3 exist,
 * `NoOpMascotRenderer` is used as the default so `MascotController` is
 * fully constructible and testable on its own.
 *
 * `MascotController`'s own methods (`show`/`hide`/`animate`/
 * `positionNear`) always: (1) update internal state first, (2) delegate to
 * the renderer second. This keeps `MascotController`'s state as the single
 * source of truth for "what should currently be true", independent of
 * whether a renderer is even attached yet.
 *
 * ## requirements.md 10.1 (non-overlapping corner placement)
 *
 * The *intent* to position the mascot ("in a corner", or "near this file")
 * is tracked and forwarded correctly by this controller. The *visual*
 * guarantee that the rendered mascot never overlaps editable content or
 * interactive controls is a CSS/webview-layout concern that only task
 * 14.3's `mascot-webview.ts` can actually enforce (this controller has no
 * access to editor layout information) — this task cannot and does not
 * attempt to satisfy that part of 10.1 by itself.
 *
 * ## requirements.md 10.6 (hide/restore + "never hide proactively")
 *
 * `hide()` sets internal visibility to `false`, delegates to the renderer,
 * and shows a *persistent restore control* (`IRestoreControl`) so the user
 * can bring the mascot back without hunting for a specific command. For
 * the MVP, the default `IRestoreControl` implementation is a VS Code
 * status bar item ("🐦 Mostrar Pluvianidae") that stays visible for as
 * long as the mascot is hidden and disappears again once `show()` is
 * called. The `IRestoreControl` abstraction (mirroring the
 * `IConfirmationPrompt`/`IFixConfirmationPrompt` injectable-VS-Code-touch
 * pattern used elsewhere in this codebase) keeps this class's own state
 * logic testable without a VS Code extension host.
 *
 * requirements.md 10.6 also states the Mascota "SHALL no ocultarse
 * proactivamente en ninguna situación sin solicitud explícita del
 * Usuario". `MascotController` satisfies this invariant structurally: it
 * contains no code path that calls its own `hide()` — `hide()` is only
 * ever invoked by external callers in direct response to an explicit user
 * action (e.g. a future `pluvianidae.hideMascot` command wired up in task
 * 16.x). Any future integration code that calls `hide()` from a
 * non-user-initiated code path (e.g. from inside an event handler for an
 * analysis event) would violate this requirement — do not do that.
 */

import { MascotAnimation } from '../../core/models';

// ---------------------------------------------------------------------------
// Public interface (design.md > "11. Mascota Controller")
// ---------------------------------------------------------------------------

export interface IMascotController {
  show(): void;
  hide(): void;
  animate(animation: MascotAnimation): void;
  positionNear(filePath: string): void;
}

/** Where the mascot is currently tracked as being positioned. */
export type MascotPosition = { type: 'corner' } | { type: 'near-file'; filePath: string };

// ---------------------------------------------------------------------------
// Renderer injection point (for tasks 14.2/14.3 to plug into)
// ---------------------------------------------------------------------------

/**
 * Injectable delegate that actually renders the mascot. `MascotController`
 * calls through to this after updating its own state; it never touches
 * `vscode` or any rendering APIs directly. Task 14.2 (`animation-engine.ts`)
 * and task 14.3 (`mascot-webview.ts`) are expected to supply the real
 * implementation (e.g. a webview-backed renderer that queues/times
 * animations and enforces non-overlapping corner placement) without
 * requiring any change to `MascotController`'s public API.
 */
export interface IMascotRenderer {
  show(): void;
  hide(): void;
  positionNear(filePath: string): void;
  playAnimation(animation: MascotAnimation): void;
}

/** Default renderer: does nothing. Used until 14.2/14.3 supply a real implementation. */
export class NoOpMascotRenderer implements IMascotRenderer {
  show(): void {
    // no-op
  }

  hide(): void {
    // no-op
  }

  positionNear(_filePath: string): void {
    // no-op
  }

  playAnimation(_animation: MascotAnimation): void {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Restore control injection point (requirements.md 10.6's "persistent
// restore control")
// ---------------------------------------------------------------------------

/**
 * Injectable abstraction over the persistent UI control shown while the
 * mascot is hidden, letting the user restore it. Mirrors the
 * `IConfirmationPrompt`/`IFixConfirmationPrompt` pattern used elsewhere in
 * this codebase for isolating `vscode`-touching UI behind a narrow
 * interface, so `MascotController`'s state logic remains testable without
 * a VS Code extension host.
 */
export interface IRestoreControl {
  /** Shows the control; `onRestore` is invoked when the user activates it (e.g. clicks it). */
  show(onRestore: () => void): void;
  /** Hides the control. Safe to call even if it is already hidden. */
  hide(): void;
}

/**
 * Default `IRestoreControl`: a VS Code status bar item reading
 * "🐦 Mostrar Pluvianidae". Clicking it runs the registered command, which
 * invokes the `onRestore` callback passed to `show()`.
 */
export class StatusBarRestoreControl implements IRestoreControl {
  private static readonly COMMAND_ID = 'pluvianidae.restoreMascot';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private statusBarItem: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private commandRegistration: any | undefined;

  show(onRestore: () => void): void {
    // Imported lazily so this module's pure state-tracking logic
    // (MascotController) can be loaded and unit tested without a VS Code
    // extension host; only this default implementation touches `vscode`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    if (!this.statusBarItem) {
      this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
      this.statusBarItem.text = '🐦 Mostrar Pluvianidae';
      this.statusBarItem.tooltip = 'Restaurar la visibilidad de la mascota de Pluvianidae';
      this.statusBarItem.command = StatusBarRestoreControl.COMMAND_ID;
    }

    // Re-registering on every show() (after disposing any previous
    // registration) keeps `onRestore` correctly bound to the latest
    // caller-provided callback without leaking prior registrations.
    this.commandRegistration?.dispose();
    this.commandRegistration = vscode.commands.registerCommand(StatusBarRestoreControl.COMMAND_ID, onRestore);

    this.statusBarItem.show();
  }

  hide(): void {
    this.statusBarItem?.hide();
    this.commandRegistration?.dispose();
    this.commandRegistration = undefined;
  }
}

// ---------------------------------------------------------------------------
// MascotController
// ---------------------------------------------------------------------------

/**
 * Implements `IMascotController`. Tracks visibility and position state,
 * delegating actual rendering to an injected `IMascotRenderer` and the
 * hidden-state restore affordance to an injected `IRestoreControl`. See
 * this module's doc comment for the full division of responsibility and
 * the 10.6 "never hide proactively" invariant.
 */
export class MascotController implements IMascotController {
  private visible = true;
  private position: MascotPosition = { type: 'corner' };

  constructor(
    private readonly renderer: IMascotRenderer = new NoOpMascotRenderer(),
    private readonly restoreControl: IRestoreControl = new StatusBarRestoreControl(),
  ) {}

  /**
   * Shows the mascot (requirements.md 10.1: visible by default, "aparece
   * discretamente"). Also hides the persistent restore control, since it
   * is only meaningful while the mascot is hidden.
   */
  show(): void {
    this.visible = true;
    this.restoreControl.hide();
    this.renderer.show();
  }

  /**
   * Hides the mascot and shows the persistent restore control
   * (requirements.md 10.6). MUST only ever be called in direct response to
   * an explicit user action — see this module's doc comment.
   */
  hide(): void {
    this.visible = false;
    this.renderer.hide();
    this.restoreControl.show(() => this.show());
  }

  /** Delegates animation playback to the injected renderer (see 14.2/14.3). */
  animate(animation: MascotAnimation): void {
    this.renderer.playAnimation(animation);
  }

  /**
   * Tracks that the mascot should be positioned near `filePath` and
   * forwards that intent to the renderer. The actual non-overlapping
   * visual placement (requirements.md 10.1) is enforced by the renderer
   * (task 14.3), not by this method.
   */
  positionNear(filePath: string): void {
    this.position = { type: 'near-file', filePath };
    this.renderer.positionNear(filePath);
  }

  /** Whether the mascot is currently tracked as visible. */
  isCurrentlyVisible(): boolean {
    return this.visible;
  }

  /** The mascot's currently tracked position (corner, or near a specific file). */
  getCurrentPosition(): MascotPosition {
    return this.position;
  }
}
