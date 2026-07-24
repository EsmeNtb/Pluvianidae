/**
 * Seed presentation ("cesto de semillas" / basket view) —
 * `presentation/seed-basket-view.ts`.
 *
 * Implements the visual "cesto de semillas" that requirements.md 9.5 and
 * 9.7 describe: a persistently visible list of pending `Seed`s (with a
 * total pending count) that the user can open without extra navigation,
 * and where clicking a seed shows its full detail (description, location,
 * suggested action). See design.md > "10. Motor de Semillas
 * (`modules/seed-engine/`)" for the `ISeedEngine` this view reads from.
 *
 * ## TreeView vs Webview
 *
 * design.md doesn't mandate one over the other for this task ("Create VS
 * Code TreeView or Webview showing pending seeds"). A VS Code `TreeView` is
 * used here rather than a Webview:
 *
 *   - It is the idiomatic VS Code UI for "a list of items with a count,
 *     where clicking an item does something" — no custom HTML/CSS/JS is
 *     needed, and it integrates natively with the sidebar.
 *   - Registering it as a view (`contributes.views`) makes it "always
 *     visible ... sin navegación adicional" (9.5) by construction: it's a
 *     permanent part of a sidebar, not a panel the user has to open via a
 *     command first.
 *   - A Webview remains the right tool for the Mascota (task 14.3), which
 *     needs custom animations that a TreeView cannot render — that is a
 *     deliberately separate module and out of scope here.
 *
 * ## View container placement
 *
 * The view is registered under VS Code's built-in "explorer" container
 * (`contributes.views.explorer`) rather than a new dedicated "Pluvianidae"
 * activity-bar container. A whole new activity-bar entry is more UI
 * footprint than this MVP feature needs; the Explorer sidebar is already
 * always reachable with one click, which satisfies "sin navegación
 * adicional" just as well. See `package.json`'s `contributes.views`.
 *
 * ## Total pending count (9.5)
 *
 * Both mechanisms are used for maximum compatibility/clarity:
 *   - `vscode.TreeView.badge` — a small numeric badge VS Code renders next
 *     to the view's title in the sidebar (supported by the installed
 *     `@types/vscode` — see `ViewBadge`/`TreeView.badge`).
 *   - `vscode.TreeView.description` — text VS Code renders inline next to
 *     the view's title (e.g. "3 semillas pendientes"), which remains
 *     visible even for VS Code versions/skins where the badge is easy to
 *     miss.
 * When there are zero pending seeds, the text explicitly reads "0 semillas
 * pendientes" (never blank), per the literal requirement text.
 *
 * ## Full detail on selection (9.7), with state-transition actions
 *
 * Each tree item's `command` is wired to `pluvianidae.showSeedDetail`
 * (registered by `registerSeedBasketView`), which shows the seed's full
 * detail — description, `file:line` location (when present), and
 * suggested action — via a non-modal `vscode.window.showInformationMessage`.
 * This mirrors the simple, non-modal informational-message pattern already
 * used for "just show me information" flows in this codebase (e.g.
 * `readme-generator.ts`'s omitted-sections notice), as opposed to the
 * modal *confirmation* dialogs used in `bedrock-client.ts`/
 * `fix-confirmation.ts` for actions that mutate state.
 *
 * That same message is also where the seed's state (requirements.md 9.2,
 * 9.3, 9.4) can be transitioned: `showInformationMessage` is called with
 * one action button per valid next state from `seed.state`, computed via
 * `getTransitionButtons`/`formatTransitionButtonLabel` from
 * `VALID_SEED_TRANSITIONS` (`core/models.ts`) — never a hardcoded
 * duplicate of that state machine. Terminal states (`'Resuelta'`,
 * `'Ignorada'`) get no buttons, just the detail text. Clicking a button
 * calls `ISeedEngine.updateState` and then emits `seed:updated` on the
 * `IEventBus` passed into `registerSeedBasketView`, which is what lets the
 * mascot's `wireMascotToEventBus` and this view's own refresh wiring (both
 * subscribed in `extension.ts`) react to the change.
 *
 * ## Refresh contract
 *
 * `SeedBasketTreeDataProvider.refresh()` fires `onDidChangeTreeData`,
 * telling VS Code to re-pull `getChildren()`/`getTreeItem()`. This module
 * does not itself subscribe to the Event Bus — wiring "seed created/seed
 * state changed → call refresh()" is the responsibility of extension
 * activation (task 16.1), which already owns wiring analysis findings →
 * seed creation → mascot animations via the Event Bus. `refresh()` is the
 * integration point that wiring is expected to call.
 */

import { Seed, SeedState, VALID_SEED_TRANSITIONS } from '../core/models';
import { ISeedEngine } from '../modules/seed-engine/seed-engine';
import { IEventBus } from '../core/event-bus';

// ---------------------------------------------------------------------------
// Pure formatting/data-selection logic (testable without a VS Code host)
// ---------------------------------------------------------------------------

/** Maximum length of a tree row's label before truncation, to keep the sidebar readable. */
export const LABEL_TRUNCATE_LENGTH = 60;

/**
 * Truncates `text` to `LABEL_TRUNCATE_LENGTH` characters, appending an
 * ellipsis when truncated, for use as a `TreeItem.label`.
 */
export function truncateLabel(text: string, maxLength: number = LABEL_TRUNCATE_LENGTH): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Builds the pending-count text shown in the basket's title area
 * (requirements.md 9.5: "0 semillas pendientes" when none exist, the
 * actual count otherwise — always explicit, never blank).
 */
export function formatPendingCountText(count: number): string {
  return `${count} semilla${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'}`;
}

/**
 * Builds the full detail text for a seed (requirements.md 9.7): its
 * description, its location as `file:line` when present (gracefully
 * omitted when the seed has no location), and its suggested action when
 * present.
 */
export function formatSeedDetail(seed: Seed): string {
  const lines = [`Tipo: ${seed.type}`, `Descripción: ${seed.description}`];

  if (seed.location) {
    lines.push(`Ubicación: ${seed.location.filePath}:${seed.location.line}`);
  }

  if (seed.suggestedAction) {
    lines.push(`Acción sugerida: ${seed.suggestedAction}`);
  }

  return lines.join('\n');
}

/**
 * Human-readable button label for transitioning a seed *to* `state`, shown
 * as an action button on the seed detail message (requirements.md 9.2,
 * 9.3, 9.4's UI counterpart). Kept as a small, colocated, pure mapping so
 * it stays testable without a VS Code host and so its wording is easy to
 * find in one place.
 */
export function formatTransitionButtonLabel(state: SeedState): string {
  switch (state) {
    case 'En revisión':
      return 'Marcar en revisión';
    case 'Resuelta':
      return 'Resolver';
    case 'Ignorada':
      return 'Ignorar';
    case 'Pendiente':
      // Unreachable via VALID_SEED_TRANSITIONS (no state transitions back
      // to 'Pendiente'), but handled defensively rather than throwing.
      return 'Marcar pendiente';
  }
}

/**
 * Builds the ordered list of `{ label, state }` action buttons to offer
 * for a seed currently in `currentState`, derived directly from
 * `VALID_SEED_TRANSITIONS` (`core/models.ts`) so the UI can never drift
 * out of sync with the state machine it drives. Terminal states
 * (`'Resuelta'`, `'Ignorada'`) yield an empty list.
 */
export function getTransitionButtons(currentState: SeedState): Array<{ label: string; state: SeedState }> {
  return VALID_SEED_TRANSITIONS[currentState].map((state) => ({
    label: formatTransitionButtonLabel(state),
    state,
  }));
}

// ---------------------------------------------------------------------------
// Command id (registered by registerSeedBasketView, referenced by
// SeedBasketTreeDataProvider.getTreeItem's TreeItem.command)
// ---------------------------------------------------------------------------

/** Command that shows a single seed's full detail (requirements.md 9.7). Registered by `registerSeedBasketView`. */
export const SHOW_SEED_DETAIL_COMMAND = 'pluvianidae.showSeedDetail';

/**
 * Plain-object shape returned by `SeedBasketTreeDataProvider.getTreeItem`.
 * Structurally compatible with `vscode.TreeItem` (VS Code reads these
 * properties off whatever object `getTreeItem` returns at runtime — it
 * does not require an actual `vscode.TreeItem` instance), which is what
 * lets `getTreeItem` be built and unit tested as pure data without
 * touching the `vscode` module at all.
 */
export interface SeedTreeItem {
  label: string;
  description: string;
  tooltip: string;
  /** `vscode.TreeItemCollapsibleState.None` (`0`) — seeds have no children. */
  collapsibleState: 0;
  command: {
    command: string;
    title: string;
    arguments: [Seed];
  };
}

// ---------------------------------------------------------------------------
// TreeDataProvider
// ---------------------------------------------------------------------------

/**
 * Minimal event emitter matching the shape of `vscode.Event<void>`
 * (`(listener: () => void) => Disposable`) without touching the `vscode`
 * module at all. `vscode.TreeDataProvider.onDidChangeTreeData` only needs
 * something matching that shape (VS Code invokes it as a plain function to
 * subscribe), so there is no need to construct a real
 * `vscode.EventEmitter` here — keeping this out of the `vscode` API
 * surface is what lets `SeedBasketTreeDataProvider` be constructed and
 * exercised in unit tests without a running VS Code extension host (unlike
 * `getTreeItem`, which does need `vscode.TreeItem`).
 */
class SimpleEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

/**
 * `vscode.TreeDataProvider<Seed>`-shaped backing store for the seed basket
 * view. Reads pending seeds from the injected `ISeedEngine` on every
 * `getChildren()` call — there is no separate cache to keep in sync, so a
 * `refresh()` call is always enough to bring the view up to date.
 *
 * This class never touches the `vscode` module directly (see
 * `SeedTreeItem`'s doc comment), so it can be constructed and exercised in
 * unit tests without a running VS Code extension host.
 */
export class SeedBasketTreeDataProvider {
  private readonly seedEngine: ISeedEngine;
  private readonly changeEmitter = new SimpleEventEmitter<void>();

  /** `vscode.TreeDataProvider<Seed>.onDidChangeTreeData` — fired by `refresh()`. */
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(seedEngine: ISeedEngine) {
    this.seedEngine = seedEngine;
  }

  /** Tells VS Code to re-pull tree data. Call after seeds are created or change state. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  /** Pending seeds only (requirements.md 9.5's basket is the pending-seed list). */
  getChildren(): Seed[] {
    return this.seedEngine.getPendingSeeds();
  }

  /**
   * Builds the tree item for `seed`: a truncated description as the
   * label, the seed's type as the (dimmed) inline description, and a
   * command wired to show the seed's full detail on click (9.7).
   */
  getTreeItem(seed: Seed): SeedTreeItem {
    return {
      label: truncateLabel(seed.description),
      description: seed.type,
      tooltip: formatSeedDetail(seed),
      collapsibleState: 0,
      command: {
        command: SHOW_SEED_DETAIL_COMMAND,
        title: 'Ver detalle de la semilla',
        arguments: [seed],
      },
    };
  }
}

// ---------------------------------------------------------------------------
// VS Code registration (the only part of this module that must run inside
// an extension host)
// ---------------------------------------------------------------------------

/** View id, must match the `id` used in `package.json`'s `contributes.views.explorer` entry. */
export const SEED_BASKET_VIEW_ID = 'pluvianidae.seedBasket';

/**
 * Registers the seed basket `TreeView` and the `pluvianidae.showSeedDetail`
 * command against a real VS Code extension host. Returns the created
 * `SeedBasketTreeDataProvider` (so callers, e.g. extension activation, can
 * call `refresh()` after wiring Event Bus listeners) and a `dispose()` that
 * cleans up both the tree view and the command registration.
 *
 * Not itself covered by unit tests (it does no decision-making of its own
 * beyond delegating to `SeedBasketTreeDataProvider`/`formatPendingCountText`/
 * `formatSeedDetail`, all of which are tested directly), mirroring
 * `IncrementalIndexer.watch()`'s documented rationale for thin VS-Code-only
 * adapters.
 */
export function registerSeedBasketView(
  seedEngine: ISeedEngine,
  eventBus: IEventBus,
): {
  provider: SeedBasketTreeDataProvider;
  dispose(): void;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode: typeof import('vscode') = require('vscode');

  const provider = new SeedBasketTreeDataProvider(seedEngine);
  const treeView = vscode.window.createTreeView<Seed>(SEED_BASKET_VIEW_ID, {
    treeDataProvider: provider,
  });

  const updateCount = () => {
    const count = seedEngine.getPendingSeeds().length;
    const text = formatPendingCountText(count);
    treeView.description = text;
    treeView.badge = { value: count, tooltip: text };
  };
  updateCount();
  const onDidChange = provider.onDidChangeTreeData(() => updateCount());

  // Shows the seed's full detail (9.7) alongside action buttons for its
  // valid next states (9.2, 9.3, 9.4's UI counterpart), computed from
  // VALID_SEED_TRANSITIONS via getTransitionButtons so the buttons offered
  // can never drift out of sync with the state machine. Terminal states
  // get no buttons — just the detail text. Clicking a button calls
  // seedEngine.updateState and emits 'seed:updated', which both the
  // mascot's wireMascotToEventBus and this view's own
  // extension.ts-level refresh subscription already react to.
  const showDetailCommand = vscode.commands.registerCommand(SHOW_SEED_DETAIL_COMMAND, async (seed: Seed) => {
    const buttons = getTransitionButtons(seed.state);
    const selection = await vscode.window.showInformationMessage(
      formatSeedDetail(seed),
      ...buttons.map((button) => button.label),
    );
    if (!selection) {
      return;
    }

    const chosen = buttons.find((button) => button.label === selection);
    if (!chosen) {
      return;
    }

    const updated = seedEngine.updateState(seed.id, chosen.state);
    eventBus.emit({ type: 'seed:updated', payload: { id: updated.id, newState: updated.state } });
  });

  return {
    provider,
    dispose: () => {
      onDidChange.dispose();
      treeView.dispose();
      showDetailCommand.dispose();
    },
  };
}
