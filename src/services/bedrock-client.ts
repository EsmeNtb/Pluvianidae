/**
 * Bedrock Client service.
 *
 * Wrapper around Amazon Bedrock used for semantic search, README
 * generation, and repository explanations. Every call requires prior user
 * confirmation showing exactly what will be transmitted, enforces a 10s
 * timeout, and degrades gracefully when Bedrock is unavailable or errors
 * out. See design.md > "12. Bedrock Client (`services/bedrock-client.ts`)"
 * and requirements.md > Requirement 2.1 and Requirement 11 (11.3, 11.4).
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DEFAULT_CONFIG, PluvianidaeConfig } from '../core/models';

export interface IBedrockClient {
  /**
   * Sends `prompt` to Amazon Bedrock for semantic interpretation, using
   * `context` to describe what will be transmitted. If
   * `context.requiresConfirmation` is true, the user is shown the file
   * names and code snippet previews and must explicitly confirm before
   * anything is sent; rejecting throws `BedrockTransmissionCancelledError`
   * and no data is transmitted. Throws `BedrockTimeoutError` if the call
   * does not complete within 10 seconds, or `BedrockQueryError` for any
   * other failure.
   */
  query(prompt: string, context: BedrockContext): Promise<string>;
  /**
   * Lightweight check for whether Bedrock can currently be reached.
   * Never throws — returns `false` on any failure (missing configuration,
   * connectivity issues, etc.) instead of propagating an error.
   */
  isAvailable(): Promise<boolean>;
}

export interface BedrockContext {
  files: string[];
  codeSnippets: string[];
  requiresConfirmation: boolean;
}

/** Maximum time allowed for a single Bedrock call, per requirements.md 2.6 / design.md Error Handling. */
export const BEDROCK_QUERY_TIMEOUT_MS = 10_000;

/**
 * Thrown when the user rejects the transmission confirmation dialog.
 * Distinct from `BedrockTimeoutError`/`BedrockQueryError` so callers can
 * detect cancellation (requirements.md 11.4: cancel without sending data,
 * keep the previous operation state) separately from a real failure.
 */
export class BedrockTransmissionCancelledError extends Error {
  constructor() {
    super('Bedrock transmission cancelled by the user.');
    this.name = 'BedrockTransmissionCancelledError';
  }
}

/** Thrown when a Bedrock call does not complete within `BEDROCK_QUERY_TIMEOUT_MS`. */
export class BedrockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Amazon Bedrock did not respond within ${timeoutMs}ms.`);
    this.name = 'BedrockTimeoutError';
  }
}

/**
 * Thrown for any other Bedrock/SDK failure. Carries only a generic message
 * for the caller; the original error is logged internally (never leaked to
 * the user) per design.md's "Error de respuesta" handling.
 */
export class BedrockQueryError extends Error {
  constructor(message = 'No se pudo completar la consulta a Amazon Bedrock.') {
    super(message);
    this.name = 'BedrockQueryError';
  }
}

/**
 * Injectable abstraction over the confirmation dialog shown before
 * transmitting data to Bedrock (requirements.md 11.3). The default
 * implementation uses `vscode.window.showInformationMessage`; tests supply
 * a stub so the flow can be exercised without a real VS Code UI.
 */
export interface IConfirmationPrompt {
  /** Resolves to `true` if the user confirms transmission, `false` if they reject it. */
  confirm(files: string[], codeSnippets: string[]): Promise<boolean>;
}

/** Number of characters from each snippet shown in the confirmation preview. */
const SNIPPET_PREVIEW_LENGTH = 200;

/**
 * Default confirmation prompt: shows file names and a short preview of each
 * code snippet via `vscode.window.showWarningMessage`, with "Confirmar" /
 * "Cancelar" actions. Requires no response other than the explicit
 * "Confirmar" action to be treated as confirmed (dismissing the dialog,
 * e.g. by pressing Escape, is treated as rejection).
 */
export class VsCodeConfirmationPrompt implements IConfirmationPrompt {
  async confirm(files: string[], codeSnippets: string[]): Promise<boolean> {
    // Imported lazily so this module (and the rest of BedrockClient's pure
    // logic) can be loaded and unit tested without a VS Code extension
    // host; only this default prompt implementation touches `vscode`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    const filesList = files.length > 0 ? files.join(', ') : '(ningún archivo)';
    const snippetsPreview = codeSnippets
      .map((snippet, index) => `#${index + 1}: ${snippet.slice(0, SNIPPET_PREVIEW_LENGTH)}`)
      .join('\n');

    const message =
      `Pluvianidae enviará la siguiente información a Amazon Bedrock:\n\n` +
      `Archivos: ${filesList}\n\n` +
      `Fragmentos de código:\n${snippetsPreview || '(ningún fragmento)'}`;

    const CONFIRM = 'Confirmar';
    const CANCEL = 'Cancelar';
    const selection = await vscode.window.showWarningMessage(message, { modal: true }, CONFIRM, CANCEL);
    return selection === CONFIRM;
  }
}

/**
 * Injectable abstraction over the underlying AWS SDK client, so
 * `BedrockClient` can be unit tested with a stub that never makes a real
 * network call. Mirrors the single operation `BedrockClient` needs
 * (`ConverseCommand`), rather than exposing the full `BedrockRuntimeClient`
 * surface.
 */
export interface IBedrockRuntimeClient {
  converse(modelId: string, prompt: string): Promise<string>;
}

/**
 * Default `IBedrockRuntimeClient` implementation backed by
 * `@aws-sdk/client-bedrock-runtime`'s `BedrockRuntimeClient` and
 * `ConverseCommand`.
 */
export class AwsBedrockRuntimeClient implements IBedrockRuntimeClient {
  private readonly client: BedrockRuntimeClient;

  constructor(region: string) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async converse(modelId: string, prompt: string): Promise<string> {
    const command = new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
    });
    const response = await this.client.send(command);

    const message = response.output && 'message' in response.output ? response.output.message : undefined;
    const textBlock = message?.content?.find((block): block is { text: string } => typeof block.text === 'string');
    return textBlock?.text ?? '';
  }
}

/**
 * Wrapper for communication with Amazon Bedrock with mandatory user
 * confirmation before any data is transmitted (requirements.md 11.3, 11.4),
 * a 10-second timeout, and generic-error handling that never leaks
 * internal failure details to the user (design.md Error Handling >
 * "Errores de servicio externo").
 *
 * Both the underlying AWS SDK client and the confirmation dialog are
 * injectable via the constructor (mirroring `IncrementalIndexer`'s
 * constructor pattern: real defaults with optional injected overrides) so
 * this class is fully unit-testable without a VS Code UI or real AWS calls.
 */
export class BedrockClient implements IBedrockClient {
  private readonly runtimeClient: IBedrockRuntimeClient;
  private readonly confirmationPrompt: IConfirmationPrompt;
  private readonly config: PluvianidaeConfig;
  private readonly timeoutMs: number;

  constructor(
    config: PluvianidaeConfig = DEFAULT_CONFIG,
    runtimeClient: IBedrockRuntimeClient = new AwsBedrockRuntimeClient(config.bedrockRegion),
    confirmationPrompt: IConfirmationPrompt = new VsCodeConfirmationPrompt(),
    timeoutMs: number = BEDROCK_QUERY_TIMEOUT_MS,
  ) {
    this.config = config;
    this.runtimeClient = runtimeClient;
    this.confirmationPrompt = confirmationPrompt;
    this.timeoutMs = timeoutMs;
  }

  async query(prompt: string, context: BedrockContext): Promise<string> {
    if (context.requiresConfirmation) {
      const confirmed = await this.confirmationPrompt.confirm(context.files, context.codeSnippets);
      if (!confirmed) {
        // requirements.md 11.4: cancel without transmitting any data and
        // keep the previous operation state — nothing has been sent yet.
        throw new BedrockTransmissionCancelledError();
      }
    }

    return this.invokeWithTimeout(prompt);
  }

  async isAvailable(): Promise<boolean> {
    try {
      // A full inference call is unnecessary (and costly) just to probe
      // availability. This MVP check confirms Bedrock configuration
      // (region + model) is present; combined with the query()-time
      // timeout/error handling, transient connectivity failures are still
      // surfaced to the user when an actual query is attempted.
      if (!this.config.bedrockRegion || !this.config.bedrockModelId) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async invokeWithTimeout(prompt: string): Promise<string> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new BedrockTimeoutError(this.timeoutMs)), this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.runtimeClient.converse(this.config.bedrockModelId, prompt),
        timeoutPromise,
      ]);
    } catch (err) {
      if (err instanceof BedrockTimeoutError) {
        throw err;
      }
      const description = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[Pluvianidae] Bedrock query error: ${description}`);
      throw new BedrockQueryError();
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
