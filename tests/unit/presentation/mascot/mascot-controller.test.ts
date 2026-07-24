import { describe, it, expect, beforeEach } from 'vitest';
import {
  MascotController,
  IMascotRenderer,
  IRestoreControl,
} from '../../../../src/presentation/mascot/mascot-controller';
import { MascotAnimation } from '../../../../src/core/models';

/** Records every call made to it, for assertions. */
class StubMascotRenderer implements IMascotRenderer {
  public showCalls = 0;
  public hideCalls = 0;
  public positionNearCalls: string[] = [];
  public playedAnimations: MascotAnimation[] = [];

  show(): void {
    this.showCalls++;
  }

  hide(): void {
    this.hideCalls++;
  }

  positionNear(filePath: string): void {
    this.positionNearCalls.push(filePath);
  }

  playAnimation(animation: MascotAnimation): void {
    this.playedAnimations.push(animation);
  }
}

/** Records show/hide calls and captures the onRestore callback so tests can simulate the user clicking "restore". */
class StubRestoreControl implements IRestoreControl {
  public showCalls = 0;
  public hideCalls = 0;
  public lastOnRestore: (() => void) | undefined;

  show(onRestore: () => void): void {
    this.showCalls++;
    this.lastOnRestore = onRestore;
  }

  hide(): void {
    this.hideCalls++;
  }
}

describe('MascotController', () => {
  let renderer: StubMascotRenderer;
  let restoreControl: StubRestoreControl;
  let controller: MascotController;

  beforeEach(() => {
    renderer = new StubMascotRenderer();
    restoreControl = new StubRestoreControl();
    controller = new MascotController(renderer, restoreControl);
  });

  it('is visible by default (requirements.md 10.1)', () => {
    expect(controller.isCurrentlyVisible()).toBe(true);
  });

  it('show() delegates to the renderer and sets visible state', () => {
    controller.hide();
    renderer.showCalls = 0;

    controller.show();

    expect(controller.isCurrentlyVisible()).toBe(true);
    expect(renderer.showCalls).toBe(1);
  });

  it('hide() delegates to the renderer, sets visible state to false, and shows the restore control', () => {
    controller.hide();

    expect(controller.isCurrentlyVisible()).toBe(false);
    expect(renderer.hideCalls).toBe(1);
    expect(restoreControl.showCalls).toBe(1);
  });

  it('clicking the restore control calls show() again and hides the restore control', () => {
    controller.hide();
    expect(restoreControl.lastOnRestore).toBeDefined();

    restoreControl.lastOnRestore!();

    expect(controller.isCurrentlyVisible()).toBe(true);
    expect(renderer.showCalls).toBe(1);
    expect(restoreControl.hideCalls).toBe(1);
  });

  it('animate() delegates the animation to the renderer', () => {
    const animation: MascotAnimation = { type: 'celebration' };

    controller.animate(animation);

    expect(renderer.playedAnimations).toEqual([animation]);
  });

  it('positionNear() updates tracked position and delegates to the renderer', () => {
    controller.positionNear('src/index.ts');

    expect(controller.getCurrentPosition()).toEqual({ type: 'near-file', filePath: 'src/index.ts' });
    expect(renderer.positionNearCalls).toEqual(['src/index.ts']);
  });
});
