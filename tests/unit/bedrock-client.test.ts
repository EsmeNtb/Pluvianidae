import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BedrockClient,
  BedrockContext,
  BedrockQueryError,
  BedrockTimeoutError,
  BedrockTransmissionCancelledError,
  IBedrockRuntimeClient,
  IConfirmationPrompt,
} from '../../src/services/bedrock-client';
import { DEFAULT_CONFIG } from '../../src/core/models';

class StubRuntimeClient implements IBedrockRuntimeClient {
  converseMock = vi.fn<[string, string], Promise<string>>();

  async converse(modelId: string, prompt: string): Promise<string> {
    return this.converseMock(modelId, prompt);
  }
}

class StubConfirmationPrompt implements IConfirmationPrompt {
  confirmMock = vi.fn<[string[], string[]], Promise<boolean>>();

  async confirm(files: string[], codeSnippets: string[]): Promise<boolean> {
    return this.confirmMock(files, codeSnippets);
  }
}

function makeContext(overrides: Partial<BedrockContext> = {}): BedrockContext {
  return {
    files: ['src/foo.ts'],
    codeSnippets: ['export function foo() {}'],
    requiresConfirmation: true,
    ...overrides,
  };
}

describe('BedrockClient', () => {
  let runtimeClient: StubRuntimeClient;
  let confirmationPrompt: StubConfirmationPrompt;
  let client: BedrockClient;

  beforeEach(() => {
    runtimeClient = new StubRuntimeClient();
    confirmationPrompt = new StubConfirmationPrompt();
    client = new BedrockClient(DEFAULT_CONFIG, runtimeClient, confirmationPrompt);
  });

  describe('query - successful transmission', () => {
    it('shows the confirmation prompt with files/snippets and transmits after confirmation', async () => {
      confirmationPrompt.confirmMock.mockResolvedValue(true);
      runtimeClient.converseMock.mockResolvedValue('respuesta del modelo');

      const context = makeContext();
      const result = await client.query('¿qué hace foo?', context);

      expect(result).toBe('respuesta del modelo');
      expect(confirmationPrompt.confirmMock).toHaveBeenCalledWith(context.files, context.codeSnippets);
      expect(runtimeClient.converseMock).toHaveBeenCalledWith(DEFAULT_CONFIG.bedrockModelId, '¿qué hace foo?');
    });

    it('transmits directly without confirmation when requiresConfirmation is false', async () => {
      runtimeClient.converseMock.mockResolvedValue('ok');

      const context = makeContext({ requiresConfirmation: false });
      const result = await client.query('hola', context);

      expect(result).toBe('ok');
      expect(confirmationPrompt.confirmMock).not.toHaveBeenCalled();
      expect(runtimeClient.converseMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('query - cancellation', () => {
    it('throws BedrockTransmissionCancelledError and never transmits when the user rejects', async () => {
      confirmationPrompt.confirmMock.mockResolvedValue(false);

      const context = makeContext();
      await expect(client.query('¿qué hace foo?', context)).rejects.toBeInstanceOf(
        BedrockTransmissionCancelledError,
      );
      expect(runtimeClient.converseMock).not.toHaveBeenCalled();
    });
  });

  describe('query - timeout', () => {
    it('throws BedrockTimeoutError when the call exceeds the timeout', async () => {
      confirmationPrompt.confirmMock.mockResolvedValue(true);
      runtimeClient.converseMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('too late'), 50)),
      );

      const fastClient = new BedrockClient(DEFAULT_CONFIG, runtimeClient, confirmationPrompt, 5);

      await expect(fastClient.query('consulta', makeContext())).rejects.toBeInstanceOf(BedrockTimeoutError);
    });
  });

  describe('query - generic error handling', () => {
    it('throws a generic BedrockQueryError and does not leak the original error message', async () => {
      confirmationPrompt.confirmMock.mockResolvedValue(true);
      runtimeClient.converseMock.mockRejectedValue(new Error('AccessDeniedException: secret-detail-xyz'));

      const context = makeContext();
      let caught: unknown;
      try {
        await client.query('consulta', context);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BedrockQueryError);
      expect((caught as Error).message).not.toContain('secret-detail-xyz');
    });
  });

  describe('isAvailable', () => {
    it('returns true when Bedrock region and model are configured', async () => {
      await expect(client.isAvailable()).resolves.toBe(true);
    });

    it('returns false gracefully when configuration is incomplete', async () => {
      const misconfiguredClient = new BedrockClient(
        { ...DEFAULT_CONFIG, bedrockRegion: '' },
        runtimeClient,
        confirmationPrompt,
      );

      await expect(misconfiguredClient.isAvailable()).resolves.toBe(false);
    });
  });
});
