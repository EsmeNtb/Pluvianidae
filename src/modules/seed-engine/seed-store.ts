/**
 * Seed Store persistence (`modules/seed-engine/seed-store.ts`).
 *
 * Implements design.md > "Data Models" > "Seed Store":
 *
 * ```typescript
 * interface SeedStore {
 *   seeds: Map<string, Seed>;
 *   save(): Promise<void>;
 *   load(): Promise<void>;
 * }
 * ```
 *
 * See requirements.md > Requirement 9 (9.1) and Requirement 11 (11.7).
 *
 * ## Relationship to `SeedEngine` (task 13.1)
 *
 * `SeedEngine` (`seed-engine.ts`) is the authoritative, purely in-memory
 * owner of seeds during a session — it is intentionally unaware of
 * persistence (see its module doc comment). `SeedStore` is a separate,
 * persistence-focused companion, not a replacement:
 *
 *   - `save()` reads the *current* seeds from an injected
 *     `Pick<ISeedEngine, 'getAllSeeds'>` (i.e. the live `SeedEngine`
 *     instance for the session) — it does **not** read from
 *     `SeedStore.seeds`. This keeps `SeedEngine` as the single source of
 *     truth for "what seeds exist right now" while `SeedStore` only cares
 *     about serializing that snapshot to disk.
 *   - `load()` populates `SeedStore.seeds` (its own map, exactly as
 *     design.md's interface specifies) from whatever was previously
 *     persisted. design.md's `SeedStore` interface has no method to push
 *     loaded seeds back into a `SeedEngine`, so this implementation does
 *     not attempt a bidirectional sync — an orchestration layer (task
 *     16.1, extension activation) can, if desired, iterate `store.seeds`
 *     after `load()` resolves and re-hydrate a fresh `SeedEngine` from it.
 *
 * ## Consent gating (requirements.md 11.7)
 *
 * 11.7 says the Sistema must not persist data beyond the active session
 * "salvo que el Usuario otorgue consentimiento explícito". `PluvianidaeConfig`
 * already has a `persistIndex` flag, but it is named specifically for the
 * *repository index* — overloading it for an unrelated data type (seeds,
 * which are metadata about findings, not source code) would conflate two
 * independent consent decisions a user might want to make differently.
 * Instead, `SeedStore` accepts its own injectable `ISeedPersistenceConsent`
 * (mirroring the `IReadmeConfirmationPrompt` / `IConfirmationPrompt`
 * pattern used elsewhere), checked fresh every time `save()` is called:
 *
 *   - `StaticSeedPersistenceConsent` — a fixed answer, used as the default
 *     (`false`, i.e. "no persistence" is the safe-by-default behavior) and
 *     in tests.
 *   - `VsCodeSeedPersistenceConsent` — the real default a caller can opt
 *     into, showing a `vscode.window.showWarningMessage` dialog with
 *     "Permitir" / "No permitir" actions. Not wired as `SeedStore`'s own
 *     default constructor parameter (that stays `StaticSeedPersistenceConsent(false)`,
 *     so instantiating a `SeedStore` never has a side effect), but is
 *     available for the orchestration layer to pass in explicitly.
 *
 * When consent is not granted, `save()` does nothing and returns — this is
 * the expected default behavior (not persisting is not an error), so it
 * never throws for that reason.
 *
 * ## Persisted file location
 *
 * Seeds are written to `.pluvianidae/seeds.json` under the workspace root
 * — a dedicated dotfolder for Pluvianidae's own data (kept separate from
 * the analyzed repository's own files, easy to add to `.gitignore`),
 * consistent with how `ReadmeGenerator` and `PreCommitReviewer` accept a
 * `workspaceRoot` constructor parameter for their own file locations.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Seed } from '../../core/models';
import { ISeedEngine } from './seed-engine';

// ---------------------------------------------------------------------------
// Public interface (design.md > "Data Models" > "Seed Store")
// ---------------------------------------------------------------------------

export interface ISeedStore {
  seeds: Map<string, Seed>;
  save(): Promise<void>;
  load(): Promise<void>;
}

/** Dedicated dotfolder (relative to the workspace root) holding Pluvianidae's own persisted data. */
export const SEED_STORE_DIRNAME = '.pluvianidae';

/** File name (within `SEED_STORE_DIRNAME`) that stores serialized seeds. */
export const SEED_STORE_FILENAME = 'seeds.json';

// ---------------------------------------------------------------------------
// Filesystem abstraction (injectable, mirrors readme-generator's
// IReadmeFileSystem / FsReadmeFileSystem pattern)
// ---------------------------------------------------------------------------

/**
 * Narrow filesystem abstraction covering exactly what the Seed Store needs.
 * Kept separate from `IReadmeFileSystem` since this also needs `mkdir`
 * (to create the `.pluvianidae/` directory on first save).
 */
export interface ISeedFileSystem {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<void>;
}

export class FsSeedFileSystem implements ISeedFileSystem {
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Consent gating (injectable, mirrors bedrock-client.ts's
// IConfirmationPrompt / VsCodeConfirmationPrompt pattern) — see this file's
// top doc comment, "Consent gating (requirements.md 11.7)".
// ---------------------------------------------------------------------------

export interface ISeedPersistenceConsent {
  /** Resolves to `true` if the user has explicitly consented to persisting seeds to disk. */
  isGranted(): Promise<boolean>;
}

/** Fixed-answer consent, used as `SeedStore`'s safe-by-default (`false`) and in tests. */
export class StaticSeedPersistenceConsent implements ISeedPersistenceConsent {
  constructor(private readonly granted: boolean) {}

  async isGranted(): Promise<boolean> {
    return this.granted;
  }
}

/**
 * Real default a caller can opt into: shows a `vscode.window.showWarningMessage`
 * dialog asking the user to explicitly allow or deny persisting seeds.
 * Dismissing the dialog (e.g. pressing Escape) is treated as denial, same
 * as `VsCodeConfirmationPrompt` in `bedrock-client.ts`.
 */
export class VsCodeSeedPersistenceConsent implements ISeedPersistenceConsent {
  async isGranted(): Promise<boolean> {
    // Imported lazily so this module can be loaded and unit tested without
    // a VS Code extension host; only this implementation touches `vscode`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    const ALLOW = 'Permitir';
    const DENY = 'No permitir';
    const selection = await vscode.window.showWarningMessage(
      'Pluvianidae puede guardar las semillas (hallazgos pendientes) en disco ' +
        `(${SEED_STORE_DIRNAME}/${SEED_STORE_FILENAME}) para conservarlas entre sesiones. ` +
        '¿Deseas permitirlo?',
      ALLOW,
      DENY,
    );
    return selection === ALLOW;
  }
}

// ---------------------------------------------------------------------------
// SeedStore
// ---------------------------------------------------------------------------

/**
 * Implements `ISeedStore`. See this file's top doc comment for the full
 * rationale behind its relationship to `SeedEngine`, the consent gating,
 * and the persisted file location.
 */
export class SeedStore implements ISeedStore {
  /** Populated by `load()`. Empty until `load()` is called or seeds are added directly by a caller. */
  seeds: Map<string, Seed> = new Map();

  constructor(
    private readonly workspaceRoot: string,
    private readonly seedSource: Pick<ISeedEngine, 'getAllSeeds'>,
    private readonly fileSystem: ISeedFileSystem = new FsSeedFileSystem(),
    private readonly consent: ISeedPersistenceConsent = new StaticSeedPersistenceConsent(false),
  ) {}

  /**
   * Serializes the seeds currently held by the injected `seedSource`
   * (i.e. the session's live `SeedEngine`) to `.pluvianidae/seeds.json`
   * under `workspaceRoot`. Does nothing (and does not throw) if consent
   * has not been explicitly granted — see this file's top doc comment,
   * "Consent gating".
   */
  async save(): Promise<void> {
    const granted = await this.consent.isGranted();
    if (!granted) {
      return;
    }

    const seeds = this.seedSource.getAllSeeds();
    const dirPath = path.join(this.workspaceRoot, SEED_STORE_DIRNAME);
    await this.fileSystem.mkdir(dirPath);

    const serialized = JSON.stringify(seeds, null, 2);
    await this.fileSystem.writeFile(this.getTargetPath(), serialized);
  }

  /**
   * Populates `this.seeds` from `.pluvianidae/seeds.json` under
   * `workspaceRoot`, if it exists. Leaves `this.seeds` as an empty map
   * (never throws) when the file doesn't exist, or when it exists but is
   * malformed/corrupt — both are treated as "no persisted data", not as
   * errors, consistent with 11.7's persistence being opt-in rather than
   * guaranteed.
   */
  async load(): Promise<void> {
    const targetPath = this.getTargetPath();

    if (!(await this.fileSystem.fileExists(targetPath))) {
      this.seeds = new Map();
      return;
    }

    try {
      const raw = await this.fileSystem.readFile(targetPath);
      const parsedSeeds = JSON.parse(raw) as Seed[];
      const revived = new Map<string, Seed>();
      for (const seed of parsedSeeds) {
        revived.set(seed.id, reviveSeedDates(seed));
      }
      this.seeds = revived;
    } catch {
      // Malformed/corrupt file: log and treat as if no data existed,
      // rather than crashing the caller.
      // eslint-disable-next-line no-console
      console.warn(`[Pluvianidae] No se pudo leer el archivo de semillas persistidas en "${targetPath}"; se ignorará.`);
      this.seeds = new Map();
    }
  }

  private getTargetPath(): string {
    return path.join(this.workspaceRoot, SEED_STORE_DIRNAME, SEED_STORE_FILENAME);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `JSON.parse` deserializes `createdAt`/`updatedAt` as strings, not `Date`
 * instances. This restores them so `SeedStore.seeds` always holds proper
 * `Seed` objects matching `core/models.ts`'s type, regardless of whether
 * they came from `load()` or directly from a `SeedEngine`.
 */
function reviveSeedDates(seed: Seed): Seed {
  return {
    ...seed,
    createdAt: new Date(seed.createdAt),
    updatedAt: new Date(seed.updatedAt),
  };
}
