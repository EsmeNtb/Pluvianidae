/**
 * Mascota Webview (`presentation/mascot/mascot-webview.ts`).
 *
 * The rendering + Event-Bus-wiring layer for the Mascota. See design.md >
 * "11. Mascota Controller (`modules/mascot/`)" and requirements.md >
 * Requirement 9 (9.6) and Requirement 10 (10.2, 10.3, 10.5).
 *
 * This file has three sections, each documented in more detail below:
 *
 *   1. `renderMascotHtml` — a pure function that builds the mascot's HTML/
 *      CSS/SVG document from a small state object. No `vscode` dependency,
 *      fully unit testable.
 *   2. `MascotWebview` — the `IMascotRenderer` implementation that owns a
 *      real `vscode.WebviewPanel` and feeds it HTML from (1). The only
 *      `vscode`-touching class in this file.
 *   3. `wireMascotToEventBus` — a pure function that subscribes to
 *      `IEventBus` events and calls through to an injected
 *      `IMascotController`. No `vscode` dependency, fully unit testable
 *      with a real `EventBus` and a stub controller.
 *
 * This mirrors the house pattern used throughout this codebase (e.g.
 * `pre-commit-reviewer.ts`'s mix of pure check logic + a thin
 * `ChildProcessCommandRunner` `vscode`/OS adapter, `seed-basket-view.ts`'s
 * pure formatting functions + thin `registerSeedBasketView` adapter): keep
 * decision-making and content-generation logic pure and testable, and
 * isolate the unavoidable `vscode` API calls behind a narrow, thin surface
 * loaded lazily via `require('vscode')`.
 */

import { MascotAnimation } from '../../core/models';
import { IEventBus, PluvianidaeEvent } from '../../core/event-bus';
import { IMascotController } from './mascot-controller';
import { ISeedEngine } from '../../modules/seed-engine/seed-engine';

// ---------------------------------------------------------------------------
// 1. Pure HTML/CSS/SVG generation (no `vscode` dependency)
// ---------------------------------------------------------------------------

/**
 * State needed to render the mascot's webview content. Deliberately a
 * small, flat, serializable shape (not `MascotAnimation` directly) so
 * `renderMascotHtml` can also carry the `perch-on-file` file label
 * alongside whatever the *current* animation is, without forcing every
 * caller to thread a `filePath` through animation types that don't need
 * one.
 */
export interface MascotViewState {
  /** The animation currently being displayed. */
  animation: MascotAnimation['type'];
  /**
   * File name/path to show as a small label near the mascot when
   * `animation` is `'perch-on-file'` (requirements.md 10.4's "posarse
   * junto al archivo" — see this module's doc comment and
   * `MascotWebview.positionNear`'s doc comment for the MVP-fidelity
   * interpretation of "posarse junto a"). Ignored for other animations.
   */
  fileLabel?: string;
}

/** CSS class applied to the mascot graphic for each animation state, toggled via a template literal below. */
function animationClassFor(animation: MascotAnimation['type']): string {
  switch (animation) {
    case 'celebration':
      return 'mascot--celebration';
    case 'analysis-complete':
      return 'mascot--analysis-complete';
    case 'carrying-seed':
      return 'mascot--carrying-seed';
    case 'perch-on-file':
      return 'mascot--perched';
    case 'idle':
    default:
      return 'mascot--idle';
  }
}

/**
 * Renders a small seed icon overlay, shown only while carrying a seed
 * (requirements.md 10.3: "mostrar visualmente que lleva una semilla").
 */
function renderSeedOverlay(animation: MascotAnimation['type']): string {
  if (animation !== 'carrying-seed') {
    return '';
  }
  return '<div class="seed-overlay" data-testid="seed-overlay" aria-label="Llevando una semilla">🌱</div>';
}

/**
 * Renders the file label shown while perched near a problematic file
 * (requirements.md 10.4). See `MascotWebview.positionNear`'s doc comment
 * for why this is an in-panel label rather than true editor-relative
 * positioning.
 */
function renderFileLabel(state: MascotViewState): string {
  if (state.animation !== 'perch-on-file' || !state.fileLabel) {
    return '';
  }
  const escaped = escapeHtml(state.fileLabel);
  return `<div class="file-label" data-testid="file-label">📍 ${escaped}</div>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds a self-contained HTML document (inline `<style>` + inline SVG)
 * rendering the mascot in the given `state`. Pure and side-effect free —
 * no `vscode` dependency — so it can be unit tested purely on its string
 * output (e.g. asserting the seed-overlay markup is present for
 * `carrying-seed`, the file label text appears for `perch-on-file`, etc.)
 * without a real webview.
 *
 * Visual design is intentionally simple for MVP scope: a bird emoji/SVG
 * shape with CSS keyframe animations swapped in via a per-state class
 * (`mascot--idle`, `mascot--celebration`, ...). Functional correctness
 * (the right elements/classes are present for each state) matters far
 * more than visual polish here.
 */
export function renderMascotHtml(state: MascotViewState): string {
  const animationClass = animationClassFor(state.animation);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<style>
  body {
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: transparent;
    font-family: var(--vscode-font-family, sans-serif);
    overflow: hidden;
  }
  .mascot-container {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .mascot {
    font-size: 48px;
    line-height: 1;
    display: inline-block;
  }
  .seed-overlay {
    position: absolute;
    bottom: -6px;
    right: -6px;
    font-size: 18px;
  }
  .file-label {
    margin-top: 6px;
    font-size: 12px;
    color: var(--vscode-foreground, #ccc);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* requirements.md 10.2: analysis-complete reacts with a brief, distinct animation. */
  @keyframes mascot-glow {
    0%, 100% { filter: drop-shadow(0 0 0 rgba(255, 215, 0, 0)); }
    50% { filter: drop-shadow(0 0 8px rgba(255, 215, 0, 0.9)); }
  }
  .mascot--analysis-complete .mascot {
    animation: mascot-glow 0.6s ease-in-out 2;
  }

  /* requirements.md 10.5: celebration animation for a clean pre-commit review. */
  @keyframes mascot-bounce {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    25% { transform: translateY(-10px) rotate(-8deg); }
    75% { transform: translateY(-10px) rotate(8deg); }
  }
  .mascot--celebration .mascot {
    animation: mascot-bounce 0.4s ease-in-out 3;
  }

  /* requirements.md 10.3: subtle wiggle while carrying a seed. */
  @keyframes mascot-wiggle {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(4deg); }
  }
  .mascot--carrying-seed .mascot {
    animation: mascot-wiggle 1.2s ease-in-out infinite;
  }

  /* requirements.md 10.4: perched, still, near a problematic file. */
  .mascot--perched .mascot {
    transform: translateY(2px);
  }

  .mascot--idle .mascot {
    animation: none;
  }
</style>
</head>
<body>
  <div class="mascot-container ${animationClass}" data-testid="mascot-container" data-animation="${state.animation}">
    <div class="mascot" data-testid="mascot">🐦</div>
    ${renderSeedOverlay(state.animation)}
    ${renderFileLabel(state)}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 2. MascotWebview — vscode.WebviewPanel-backed IMascotRenderer
// ---------------------------------------------------------------------------

/**
 * Narrow structural type for the pieces of `vscode.WebviewPanel` this
 * class actually uses, letting tests (if ever needed) supply a stub
 * without importing real `vscode` types. Not exported/used for the real
 * implementation's typing (which uses `vscode.WebviewPanel` directly) —
 * documented here only to explain why `MascotWebview`'s public surface
 * needs no `vscode` types of its own (it implements `IMascotRenderer`,
 * which is `vscode`-free).
 */

/**
 * `IMascotRenderer` implementation backed by a `vscode.WebviewPanel`.
 *
 * ## WebviewPanel vs WebviewView (design choice)
 *
 * design.md leaves the exact webview mechanism unspecified for the
 * Mascota. A `vscode.WebviewPanel` (an editor-area panel, created via
 * `vscode.window.createWebviewPanel`) is used here rather than a
 * `WebviewView` (a sidebar-registered view requiring a
 * `contributes.views` entry + a `WebviewViewProvider`), because:
 *
 *   - It requires no `package.json` view contribution or provider
 *     registration plumbing — `show()` can lazily create the panel
 *     on first use, which is simpler for MVP scope.
 *   - `vscode.ViewColumn.Beside` positions it alongside the editor
 *     without needing a new sidebar container, giving a "corner-ish"
 *     placement that's reasonable for the MVP without needing custom
 *     editor decorations.
 *
 * A `WebviewView` in the sidebar would arguably look more like a
 * permanent "corner mascot", but the extra registration overhead isn't
 * justified for this hackathon-scoped MVP; documented here as a
 * deliberate simplification, not an oversight.
 *
 * ## `positionNear` — MVP-fidelity interpretation of "posarse junto al archivo" (10.4)
 *
 * A `WebviewPanel` cannot literally overlay a specific line or file tab in
 * the editor without custom editor decorations (out of scope — see
 * `mascot-controller.ts`'s doc comment, which explicitly defers "visual
 * placement enforcement" to this file but does not require pixel-perfect
 * editor-relative positioning). `positionNear(filePath)` is therefore
 * implemented pragmatically: it updates the webview's rendered state to
 * show a small label (`📍 <filename>`) identifying which file is
 * problematic, directly inside the mascot panel itself, rather than moving
 * any UI element to editor coordinates. This satisfies 10.4's intent
 * ("indicate which file has a problem") at MVP fidelity without the
 * complexity of custom decorations.
 *
 * ## `playAnimation` — full HTML regeneration vs `postMessage` (design choice)
 *
 * Two ways to update the rendered animation were considered:
 *   (a) Send a `postMessage` to already-loaded webview JS, which toggles
 *       CSS classes client-side without reloading the document.
 *   (b) Regenerate `panel.webview.html` from `renderMascotHtml` with the
 *       new state baked in, causing a full document reload.
 *
 * (b) is used here: it requires no client-side message-listener script
 * (the webview's `<body>` is pure static markup, no `<script>` needed at
 * all), which is simpler to implement correctly and sufficient for this
 * MVP's animation frequency (a handful of state changes per session, not
 * a high-frequency stream) — a full reload's flicker is an acceptable
 * tradeoff for that simplicity. Documented here as a deliberate choice,
 * not an oversight; a future iteration wanting flicker-free transitions
 * could switch to `postMessage` without changing this class's public API.
 */
export class MascotWebview {
  private state: MascotViewState = { animation: 'idle' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private panel: any | undefined;

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    // Imported lazily so the pure logic in this file (renderMascotHtml,
    // wireMascotToEventBus) can be loaded and unit tested without a VS
    // Code extension host; only this method touches `vscode`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    this.panel = vscode.window.createWebviewPanel('pluvianidaeMascot', 'Pluvianidae', vscode.ViewColumn.Beside, {
      enableScripts: false,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.render();
  }

  hide(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  /** See this class's doc comment for the MVP-fidelity interpretation of "posarse junto al archivo" (10.4). */
  positionNear(filePath: string): void {
    this.state = { animation: 'perch-on-file', fileLabel: filePath };
    this.render();
  }

  /** See this class's doc comment for the full-HTML-regeneration-vs-postMessage design choice. */
  playAnimation(animation: MascotAnimation): void {
    this.state =
      animation.type === 'perch-on-file'
        ? { animation: animation.type, fileLabel: animation.filePath }
        : { animation: animation.type };
    this.render();
  }

  private render(): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = renderMascotHtml(this.state);
  }
}

// ---------------------------------------------------------------------------
// 3. wireMascotToEventBus — pure Event Bus wiring (no `vscode` dependency)
// ---------------------------------------------------------------------------

/** Minimal `Disposable` shape, matching `core/event-bus.ts`'s local `Disposable`. */
export interface Disposable {
  dispose(): void;
}

/**
 * Subscribes `mascotController` to the Event Bus events relevant to the
 * Mascota's animations, and returns a `Disposable` that tears down all of
 * the underlying subscriptions at once.
 *
 * ## Event → animation mapping
 *
 *   - `indexing:completed` → `animate({ type: 'analysis-complete' })`
 *     (requirements.md 10.2: "el Sistema completa un análisis").
 *   - `precommit:completed` with `payload.hasErrors === false` →
 *     `animate({ type: 'celebration' })` (requirements.md 10.5). See
 *     `core/event-bus.ts`'s doc comment on this event variant: it is an
 *     additive event added by this task so 10.5 has something to wire to;
 *     `PreCommitReviewer` itself does not yet emit it (task 16.1's
 *     responsibility). When `hasErrors` is `true`, no animation is
 *     triggered here — a review that found errors is not a "sin errores"
 *     (clean) review per 10.5's literal wording.
 *   - `seed:created` and `seed:updated` → re-evaluate
 *     `seedEngineSource.getPendingSeeds().length` and transition
 *     accordingly (requirements.md 9.6 and Property 21: "the Mascota
 *     SHALL display the carrying-seed visual if and only if there exists
 *     at least one seed in state 'Pendiente'"). This is a deliberate
 *     "recompute pending count on every seed event" approach rather than
 *     a one-shot `carrying-seed` animation fired only on `seed:created`:
 *     9.6's "WHILE ... AND cantidad > 0" phrasing describes an ongoing
 *     condition, not a momentary event, so the carrying-seed visual must
 *     also go away once the last pending seed is resolved/ignored — a
 *     `seed:updated` event that brings the pending count to zero
 *     transitions the mascot to `idle`. Re-checking the count (rather than
 *     trusting the specific event's payload) also means this stays
 *     correct even if multiple seeds change state in close succession.
 *
 * Returns a `Disposable` aggregating the underlying `IEventBus.on(...)`
 * subscriptions, so this wiring can be cleanly torn down (e.g. on
 * extension deactivation).
 */
export function wireMascotToEventBus(
  eventBus: IEventBus,
  mascotController: IMascotController,
  seedEngineSource: Pick<ISeedEngine, 'getPendingSeeds'>,
): Disposable {
  const updatePendingSeedVisual = (): void => {
    const pendingCount = seedEngineSource.getPendingSeeds().length;
    if (pendingCount > 0) {
      mascotController.animate({ type: 'carrying-seed' });
    } else {
      mascotController.animate({ type: 'idle' });
    }
  };

  const subscriptions: Disposable[] = [
    eventBus.on('indexing:completed', () => {
      mascotController.animate({ type: 'analysis-complete' });
    }),

    eventBus.on('precommit:completed', (event: PluvianidaeEvent) => {
      if (event.type !== 'precommit:completed') {
        return;
      }
      if (!event.payload.hasErrors) {
        mascotController.animate({ type: 'celebration' });
      }
    }),

    eventBus.on('seed:created', () => {
      updatePendingSeedVisual();
    }),

    eventBus.on('seed:updated', () => {
      updatePendingSeedVisual();
    }),
  ];

  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}
