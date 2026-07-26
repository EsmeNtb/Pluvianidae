import { describe, it, expect, vi } from 'vitest';
import { createMascotActionDispatcher, ExecuteVsCodeCommand } from '../../../src/services/mascot-action-dispatcher';
import { DesktopMascotManager } from '../../../src/services/desktop-mascot-manager';
import { MascotAction } from '../../../../shared/mascot-actions';

// Feature: desktop-mascot, tasks.md 12.2 — pruebas unitarias del
// dispatcher: mapeo exhaustivo de las 6 acciones (con
// vscode.commands.executeCommand mockeado vía inyección de dependencia,
// sin mockear el módulo `vscode` completo) y rechazo de una acción fuera
// de la allowlist.
// **Validates: Requirements 7.3, 9.5, 12.10**

function createFakeManager(): { hide: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; manager: DesktopMascotManager } {
  const hide = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const manager = { hide, stop } as unknown as DesktopMascotManager;
  return { hide, stop, manager };
}

describe('MascotActionDispatcher > mapeo estático exhaustivo de las 6 acciones', () => {
  it('analyze-repository -> executeCommand("pluvianidae.explainRepository")', async () => {
    const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
    const { manager } = createFakeManager();
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

    await dispatcher.dispatch({ action: 'analyze-repository' });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith('pluvianidae.explainRepository');
  });

  it('precommit-review -> executeCommand("pluvianidae.preCommitReview")', async () => {
    const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
    const { manager } = createFakeManager();
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

    await dispatcher.dispatch({ action: 'precommit-review' });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith('pluvianidae.preCommitReview');
  });

  it('show-seed-basket -> executeCommand("pluvianidae.seedBasket.focus")', async () => {
    const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
    const { manager } = createFakeManager();
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

    await dispatcher.dispatch({ action: 'show-seed-basket' });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith('pluvianidae.seedBasket.focus');
  });

  it('mute-messages -> no invoca ningún comando de VS Code', async () => {
    const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
    const { manager, hide, stop } = createFakeManager();
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

    await dispatcher.dispatch({ action: 'mute-messages' });

    expect(executeCommand).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('hide-mascot -> desktopMascotManager.hide(), sin invocar ningún comando', async () => {
    const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
    const { manager, hide } = createFakeManager();
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

    await dispatcher.dispatch({ action: 'hide-mascot' });

    expect(hide).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('close-mascot -> desktopMascotManager.stop(), sin invocar ningún comando', async () => {
    const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
    const { manager, stop } = createFakeManager();
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

    await dispatcher.dispatch({ action: 'close-mascot' });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe('MascotActionDispatcher > rechazo de acciones fuera de la allowlist', () => {
  it('rechaza sin ejecutar nada un objeto inválido (fuera de la allowlist), sin lanzar', async () => {
    const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
    const { manager, hide, stop } = createFakeManager();
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

    const invalidAction = { action: 'delete-everything' } as unknown as MascotAction;

    await expect(dispatcher.dispatch(invalidAction)).resolves.toBeUndefined();

    expect(executeCommand).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('rechaza sin ejecutar nada un valor completamente ajeno a MascotAction (p. ej. null)', async () => {
    const executeCommand: ExecuteVsCodeCommand = vi.fn().mockResolvedValue(undefined);
    const { manager, hide, stop } = createFakeManager();
    const dispatcher = createMascotActionDispatcher({ desktopMascotManager: manager, executeCommand });

    const invalidAction = null as unknown as MascotAction;

    await expect(dispatcher.dispatch(invalidAction)).resolves.toBeUndefined();

    expect(executeCommand).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
