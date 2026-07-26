import { describe, it, expect } from 'vitest';
import {
  mapIndexingStartedToMascotEvent,
  mapIndexingProgressToMascotEvent,
  mapIndexingCompletedToMascotEvent,
  mapFindingToMascotEvent,
  mapPrecommitCompletedToMascotEvent,
  mapSeedCreatedToMascotEvent,
  mapErrorToMascotEvent,
} from '../../../src/services/mascot-event-mapper';
import { isMascotEvent, MASCOT_EVENT_MAX_TEXT_LENGTH } from '../../../shared/mascot-events';
import { Finding } from '../../../src/core/models';

/**
 * Unit tests for the mapping table in design.md > "Integración con la
 * extensión" > "wireDesktopMascotToEventBus — mapeo de eventos internos a
 * MascotEvent" (task 13.1 / 13.3). Every internal event in that table is
 * exercised here to confirm it produces exactly the `MascotEvent` shape
 * documented, and that every produced event passes `isMascotEvent`.
 *
 * **Validates: Requirements 8.2**
 */
describe('mascot-event-mapper', () => {
  describe('mapIndexingStartedToMascotEvent', () => {
    it('maps indexing:started to { type: "indexing", progress: 0 }', () => {
      const event = mapIndexingStartedToMascotEvent();
      expect(event).toEqual({ type: 'indexing', progress: 0 });
      expect(isMascotEvent(event)).toBe(true);
    });
  });

  describe('mapIndexingProgressToMascotEvent', () => {
    it('maps indexing:progress to { type: "indexing", file, progress: current/total*100 }', () => {
      const event = mapIndexingProgressToMascotEvent(5, 10, 'src/foo.ts');
      expect(event).toEqual({ type: 'indexing', file: 'src/foo.ts', progress: 50 });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('clamps progress to 100 when current exceeds total', () => {
      const event = mapIndexingProgressToMascotEvent(15, 10, 'src/foo.ts');
      expect(event).toEqual({ type: 'indexing', file: 'src/foo.ts', progress: 100 });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('falls back to progress 0 when total is 0 (avoids NaN/Infinity)', () => {
      const event = mapIndexingProgressToMascotEvent(0, 0, 'src/foo.ts');
      expect(event).toEqual({ type: 'indexing', file: 'src/foo.ts', progress: 0 });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('omits the file field when currentFile is empty', () => {
      const event = mapIndexingProgressToMascotEvent(1, 2, '');
      expect(event).toEqual({ type: 'indexing', progress: 50 });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('truncates currentFile to MASCOT_EVENT_MAX_TEXT_LENGTH', () => {
      const longFile = 'a'.repeat(MASCOT_EVENT_MAX_TEXT_LENGTH + 500);
      const event = mapIndexingProgressToMascotEvent(1, 2, longFile);
      expect(event).toMatchObject({ type: 'indexing', progress: 50 });
      expect(isMascotEvent(event)).toBe(true);
      if (event.type === 'indexing') {
        expect(event.file?.length).toBe(MASCOT_EVENT_MAX_TEXT_LENGTH);
      }
    });
  });

  describe('mapIndexingCompletedToMascotEvent', () => {
    it('maps indexing:completed to a success message with the file count', () => {
      const event = mapIndexingCompletedToMascotEvent(42);
      expect(event).toEqual({ type: 'success', message: 'Indexación completa (42 archivos)' });
      expect(isMascotEvent(event)).toBe(true);
    });
  });

  describe('mapFindingToMascotEvent', () => {
    it('maps a dead-code-detector finding to a warning with the finding description', () => {
      const finding: Finding = {
        type: 'dead-code:unused-function',
        sourceModule: 'dead-code-detector',
        filePath: 'src/unused.ts',
        line: 3,
        description: 'La función foo() nunca se usa.',
      };
      const event = mapFindingToMascotEvent(finding);
      expect(event).toEqual({ type: 'warning', message: 'La función foo() nunca se usa.' });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('maps a frontend-backend-comparator finding to a warning with the finding description', () => {
      const finding: Finding = {
        type: 'fb-comparator:unconsumed-endpoint',
        sourceModule: 'frontend-backend-comparator',
        filePath: 'src/routes.ts',
        line: 10,
        description: 'El endpoint GET /api/foo no es consumido por ningún llamado del frontend.',
      };
      const event = mapFindingToMascotEvent(finding);
      expect(event).toEqual({
        type: 'warning',
        message: 'El endpoint GET /api/foo no es consumido por ningún llamado del frontend.',
      });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('maps a secret-detection finding to an error mentioning the file', () => {
      const finding: Finding = {
        type: 'precommit:secret',
        sourceModule: 'pre-commit-reviewer',
        filePath: 'src/config.ts',
        line: 7,
        description: 'Posible secreto detectado (aws-access-key).',
      };
      const event = mapFindingToMascotEvent(finding);
      expect(event).toEqual({
        type: 'error',
        message: 'Se detectó un posible secreto en src/config.ts',
      });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('falls back to a placeholder file name for secret findings without filePath', () => {
      const finding: Finding = {
        type: 'precommit:secret',
        sourceModule: 'pre-commit-reviewer',
        description: 'Posible secreto detectado (aws-access-key).',
      };
      const event = mapFindingToMascotEvent(finding);
      expect(event).toEqual({
        type: 'error',
        message: 'Se detectó un posible secreto en archivo desconocido',
      });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('truncates an overly long finding description', () => {
      const finding: Finding = {
        type: 'dead-code:unused-function',
        sourceModule: 'dead-code-detector',
        description: 'x'.repeat(MASCOT_EVENT_MAX_TEXT_LENGTH + 100),
      };
      const event = mapFindingToMascotEvent(finding);
      expect(isMascotEvent(event)).toBe(true);
      if (event.type === 'warning') {
        expect(event.message.length).toBe(MASCOT_EVENT_MAX_TEXT_LENGTH);
      }
    });
  });

  describe('mapPrecommitCompletedToMascotEvent', () => {
    it('maps precommit:completed with hasErrors=false to a success message', () => {
      const event = mapPrecommitCompletedToMascotEvent(false);
      expect(event).toEqual({ type: 'success', message: 'Revisión pre-commit sin errores' });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('maps precommit:completed with hasErrors=true to a warning message', () => {
      const event = mapPrecommitCompletedToMascotEvent(true);
      expect(event).toEqual({ type: 'warning', message: 'Revisión pre-commit con hallazgos' });
      expect(isMascotEvent(event)).toBe(true);
    });
  });

  describe('mapSeedCreatedToMascotEvent', () => {
    it('maps seed:created to { type: "seed", amount }', () => {
      const event = mapSeedCreatedToMascotEvent(3);
      expect(event).toEqual({ type: 'seed', amount: 3 });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('clamps amount to at least 1 when given 0 or negative', () => {
      const event = mapSeedCreatedToMascotEvent(0);
      expect(event).toEqual({ type: 'seed', amount: 1 });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('clamps amount to at most 1000 when given a larger value', () => {
      const event = mapSeedCreatedToMascotEvent(5000);
      expect(event).toEqual({ type: 'seed', amount: 1000 });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('rounds non-integer amounts', () => {
      const event = mapSeedCreatedToMascotEvent(2.7);
      expect(event).toEqual({ type: 'seed', amount: 3 });
      expect(isMascotEvent(event)).toBe(true);
    });
  });

  describe('mapErrorToMascotEvent', () => {
    it('maps an Error instance to an error event using its message', () => {
      const event = mapErrorToMascotEvent(new Error('algo falló'));
      expect(event).toEqual({ type: 'error', message: 'algo falló' });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('maps a non-Error thrown value using String()', () => {
      const event = mapErrorToMascotEvent('boom');
      expect(event).toEqual({ type: 'error', message: 'boom' });
      expect(isMascotEvent(event)).toBe(true);
    });

    it('truncates an overly long error message', () => {
      const event = mapErrorToMascotEvent(new Error('x'.repeat(MASCOT_EVENT_MAX_TEXT_LENGTH + 100)));
      expect(isMascotEvent(event)).toBe(true);
      if (event.type === 'error') {
        expect(event.message.length).toBe(MASCOT_EVENT_MAX_TEXT_LENGTH);
      }
    });
  });
});
