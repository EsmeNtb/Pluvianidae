import { describe, it, expect } from 'vitest';
import { renderMascotHtml, wireMascotToEventBus, MascotViewState } from '../../../../src/presentation/mascot/mascot-webview';
import { EventBus } from '../../../../src/core/event-bus';
import { IMascotController } from '../../../../src/presentation/mascot/mascot-controller';
import { MascotAnimation } from '../../../../src/core/models';
import { ISeedEngine, SeedEngine } from '../../../../src/modules/seed-engine/seed-engine';

// ---------------------------------------------------------------------------
// renderMascotHtml (pure HTML/CSS/SVG generation)
// ---------------------------------------------------------------------------

describe('renderMascotHtml', () => {
  it('renders the idle state with no seed overlay or file label', () => {
    const html = renderMascotHtml({ animation: 'idle' });

    expect(html).toContain('data-animation="idle"');
    expect(html).toContain('mascot--idle');
    expect(html).not.toContain('data-testid="seed-overlay"');
    expect(html).not.toContain('data-testid="file-label"');
  });

  it('renders the analysis-complete state (10.2)', () => {
    const html = renderMascotHtml({ animation: 'analysis-complete' });

    expect(html).toContain('data-animation="analysis-complete"');
    expect(html).toContain('mascot--analysis-complete');
  });

  it('renders the carrying-seed state with a seed overlay (10.3)', () => {
    const html = renderMascotHtml({ animation: 'carrying-seed' });

    expect(html).toContain('data-animation="carrying-seed"');
    expect(html).toContain('mascot--carrying-seed');
    expect(html).toContain('data-testid="seed-overlay"');
  });

  it('renders the celebration state (10.5)', () => {
    const html = renderMascotHtml({ animation: 'celebration' });

    expect(html).toContain('data-animation="celebration"');
    expect(html).toContain('mascot--celebration');
  });

  it('renders the perch-on-file state with the given file label', () => {
    const state: MascotViewState = { animation: 'perch-on-file', fileLabel: 'src/broken.ts' };
    const html = renderMascotHtml(state);

    expect(html).toContain('data-animation="perch-on-file"');
    expect(html).toContain('mascot--perched');
    expect(html).toContain('data-testid="file-label"');
    expect(html).toContain('src/broken.ts');
  });

  it('escapes HTML-sensitive characters in the file label', () => {
    const state: MascotViewState = { animation: 'perch-on-file', fileLabel: '<script>evil.ts' };
    const html = renderMascotHtml(state);

    expect(html).not.toContain('<script>evil.ts');
    expect(html).toContain('&lt;script&gt;evil.ts');
  });

  it('omits the file label when perch-on-file has no fileLabel', () => {
    const html = renderMascotHtml({ animation: 'perch-on-file' });

    expect(html).not.toContain('data-testid="file-label"');
  });
});

// ---------------------------------------------------------------------------
// wireMascotToEventBus (pure Event Bus wiring)
// ---------------------------------------------------------------------------

/** Records every animation the controller was asked to play. */
class StubMascotController implements IMascotController {
  public animations: MascotAnimation[] = [];

  show(): void {
    // not exercised by these tests
  }

  hide(): void {
    // not exercised by these tests
  }

  animate(animation: MascotAnimation): void {
    this.animations.push(animation);
  }

  positionNear(_filePath: string): void {
    // not exercised by these tests
  }
}

function types(controller: StubMascotController): string[] {
  return controller.animations.map((a) => a.type);
}

describe('wireMascotToEventBus', () => {
  it('triggers analysis-complete on indexing:completed (10.2)', () => {
    const eventBus = new EventBus();
    const controller = new StubMascotController();
    const seedEngine: ISeedEngine = new SeedEngine();

    const subscription = wireMascotToEventBus(eventBus, controller, seedEngine);

    eventBus.emit({ type: 'indexing:completed', payload: { filesIndexed: 3, errors: [] } });

    expect(types(controller)).toEqual(['analysis-complete']);
    subscription.dispose();
  });

  it('triggers carrying-seed when seed:created fires while pending seeds exist (9.6, 10.3)', () => {
    const eventBus = new EventBus();
    const controller = new StubMascotController();
    const seedEngine: ISeedEngine = new SeedEngine();

    const subscription = wireMascotToEventBus(eventBus, controller, seedEngine);

    const seed = seedEngine.createSeed({
      type: 'problema',
      sourceModule: 'dead-code-detector',
      description: 'Variable no utilizada',
    });
    eventBus.emit({ type: 'seed:created', payload: seed });

    expect(types(controller)).toEqual(['carrying-seed']);
    subscription.dispose();
  });

  it('transitions to idle when seed:updated fires and no pending seeds remain (9.6)', () => {
    const eventBus = new EventBus();
    const controller = new StubMascotController();
    const seedEngine: ISeedEngine = new SeedEngine();

    const seed = seedEngine.createSeed({
      type: 'problema',
      sourceModule: 'dead-code-detector',
      description: 'Variable no utilizada',
    });

    const subscription = wireMascotToEventBus(eventBus, controller, seedEngine);

    // Resolve the only pending seed, then emit seed:updated — pending count is now 0.
    const updated = seedEngine.updateState(seed.id, 'Resuelta');
    eventBus.emit({ type: 'seed:updated', payload: { id: updated.id, newState: updated.state } });

    expect(types(controller)).toEqual(['idle']);
    subscription.dispose();
  });

  it('keeps carrying-seed on seed:updated when pending seeds still remain', () => {
    const eventBus = new EventBus();
    const controller = new StubMascotController();
    const seedEngine: ISeedEngine = new SeedEngine();

    const seed1 = seedEngine.createSeed({
      type: 'problema',
      sourceModule: 'dead-code-detector',
      description: 'Primer hallazgo',
    });
    seedEngine.createSeed({
      type: 'problema',
      sourceModule: 'dead-code-detector',
      description: 'Segundo hallazgo',
    });

    const subscription = wireMascotToEventBus(eventBus, controller, seedEngine);

    const updated = seedEngine.updateState(seed1.id, 'Resuelta');
    eventBus.emit({ type: 'seed:updated', payload: { id: updated.id, newState: updated.state } });

    expect(types(controller)).toEqual(['carrying-seed']);
    subscription.dispose();
  });

  it('triggers celebration on precommit:completed with no errors (10.5)', () => {
    const eventBus = new EventBus();
    const controller = new StubMascotController();
    const seedEngine: ISeedEngine = new SeedEngine();

    const subscription = wireMascotToEventBus(eventBus, controller, seedEngine);

    eventBus.emit({ type: 'precommit:completed', payload: { hasErrors: false } });

    expect(types(controller)).toEqual(['celebration']);
    subscription.dispose();
  });

  it('does not trigger celebration on precommit:completed when errors were found', () => {
    const eventBus = new EventBus();
    const controller = new StubMascotController();
    const seedEngine: ISeedEngine = new SeedEngine();

    const subscription = wireMascotToEventBus(eventBus, controller, seedEngine);

    eventBus.emit({ type: 'precommit:completed', payload: { hasErrors: true } });

    expect(types(controller)).toEqual([]);
    subscription.dispose();
  });

  it('dispose() unsubscribes from all wired events', () => {
    const eventBus = new EventBus();
    const controller = new StubMascotController();
    const seedEngine: ISeedEngine = new SeedEngine();

    const subscription = wireMascotToEventBus(eventBus, controller, seedEngine);
    subscription.dispose();

    eventBus.emit({ type: 'indexing:completed', payload: { filesIndexed: 1, errors: [] } });
    eventBus.emit({ type: 'precommit:completed', payload: { hasErrors: false } });

    expect(types(controller)).toEqual([]);
  });
});
