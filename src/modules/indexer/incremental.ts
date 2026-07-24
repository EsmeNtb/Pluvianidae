/**
 * Incremental indexing for the Indexador module.
 *
 * Watches the workspace for .js/.jsx/.ts/.tsx file creations, modifications
 * and deletions after the initial full indexation (task 2.3) has run, and
 * keeps the `RepositoryIndex` up to date by re-processing only the file
 * that changed instead of re-indexing the whole repository.
 *
 * See design.md > "3. Indexador (`modules/indexer/`)" and requirements.md >
 * Requirement 1.7.
 *
 * ## Design notes
 *
 * The module is split in two layers so the core update-dispatch logic can
 * be unit tested without a running VS Code extension host:
 *
 *   - `IncrementalIndexer` (this file's main export) contains the "pure"
 *     logic: given a file path and a change type, decide whether the file
 *     should be processed (applying the same exclusion rules as full
 *     indexing — dependency folders, `.gitignore`, Security Filter), call
 *     the matching `IIndexer` method (`updateFile`/`removeFile`), time the
 *     operation, and log a warning if it exceeds the 5-second-per-file soft
 *     target. It depends only on plain Node.js APIs and the `IIndexer`
 *     abstraction from `index-builder.ts`, so it can be exercised with a
 *     real `IndexBuilder` + temp-directory fixtures in tests.
 *   - `IncrementalIndexer.watch()` is a thin adapter that registers a
 *     `vscode.workspace.createFileSystemWatcher` and wires its
 *     `onDidCreate`/`onDidChange`/`onDidDelete` events to
 *     `handleFileChange`. This is the only part of the module that touches
 *     the `vscode` API, so it cannot be exercised outside an extension
 *     host, but it is intentionally tiny (it does no decision-making of its
 *     own) so it needs no dedicated test beyond compiling correctly against
 *     the `vscode` types.
 *
 * ## Timeout semantics (Requirement 1.7)
 *
 * The 5-second-per-file budget is a *soft* target, not a hard cutoff: if an
 * update takes longer, a warning is logged but the update is allowed to run
 * to completion and the index is still updated. This matches the refined
 * requirement semantics (continue processing until the update completes
 * rather than aborting at the 5s mark).
 *
 * ## Event Bus usage
 *
 * For consistency with full indexing (`indexRepository`, which emits
 * `indexing:started` / `indexing:progress` / `indexing:completed`), each
 * incremental update emits the same event triplet with `totalFiles: 1` /
 * `current: 1, total: 1` / `filesIndexed: 0 or 1`. This lets any UI that
 * already listens for those events (e.g. a status bar indexing indicator)
 * react to incremental updates without needing a separate event type. A
 * dedicated lighter-weight event was considered, but reusing the existing
 * indexing:* events keeps the Event Bus surface smaller and avoids
 * duplicating consumer wiring for what is conceptually the same operation
 * (updating the repository index) at a smaller scale.
 */

import * as path from 'path';
import { Disposable, EventBus, IEventBus } from '../../core/event-bus';
import { IndexError } from '../../core/models';
import { ISecurityFilter, SecurityFilter } from '../../services/security-filter';
import {
  EXCLUDED_DIRECTORY_NAMES,
  GitignorePattern,
  INDEXABLE_EXTENSIONS,
  loadGitignorePatterns,
  matchesGitignore,
} from './file-discovery';
import { IIndexer } from './index-builder';

/** Type of filesystem change that triggered an incremental update. */
export type FileChangeType = 'create' | 'modify' | 'delete';

/** Soft per-file time budget for incremental updates, per requirements.md 1.7. */
export const INCREMENTAL_UPDATE_SOFT_TIMEOUT_MS = 5000;

const INDEXABLE_EXTENSION_SET = new Set(INDEXABLE_EXTENSIONS);
const EXCLUDED_DIRECTORY_NAME_SET = new Set(EXCLUDED_DIRECTORY_NAMES);

export interface IIncrementalIndexer {
  /**
   * Processes a single file change: applies exclusion rules, then calls
   * `updateFile` (create/modify) or `removeFile` (delete) on the underlying
   * indexer. Never throws — extraction/IO errors are caught, logged as an
   * `IndexError`, and reported via the Event Bus, same as full indexing.
   */
  handleFileChange(filePath: string, changeType: FileChangeType): Promise<void>;
  /**
   * Registers a `vscode.workspace.createFileSystemWatcher` for
   * .js/.jsx/.ts/.tsx files and wires its create/change/delete events to
   * `handleFileChange`. Returns a `Disposable` that unregisters the
   * watcher.
   */
  watch(): Disposable;
}

/**
 * Drives incremental (single-file) updates to a `RepositoryIndex` built by
 * an `IIndexer` (typically `IndexBuilder`), in response to filesystem
 * changes reported either by a VS Code file watcher (`watch()`) or by any
 * other caller of `handleFileChange` (e.g. tests).
 */
export class IncrementalIndexer implements IIncrementalIndexer {
  private readonly indexer: IIndexer;
  private readonly securityFilter: ISecurityFilter;
  private readonly eventBus: IEventBus;
  private readonly softTimeoutMs: number;

  /** Cached `.gitignore` patterns, keyed by the root path they were loaded for. */
  private gitignoreCache: { rootPath: string; patterns: GitignorePattern[] } | undefined;

  constructor(
    indexer: IIndexer,
    securityFilter: ISecurityFilter = new SecurityFilter(),
    eventBus: IEventBus = new EventBus(),
    softTimeoutMs: number = INCREMENTAL_UPDATE_SOFT_TIMEOUT_MS,
  ) {
    this.indexer = indexer;
    this.securityFilter = securityFilter;
    this.eventBus = eventBus;
    this.softTimeoutMs = softTimeoutMs;
  }

  async handleFileChange(filePath: string, changeType: FileChangeType): Promise<void> {
    if (!this.isIndexableExtension(filePath)) {
      return;
    }
    if (this.isWithinExcludedDirectory(filePath)) {
      return;
    }
    if (await this.isExcludedByGitignoreOrSecurityFilter(filePath)) {
      return;
    }

    this.eventBus.emit({ type: 'indexing:started', payload: { totalFiles: 1 } });

    const startTime = Date.now();
    const errors: IndexError[] = [];
    let filesIndexed = 0;

    try {
      if (changeType === 'delete') {
        this.indexer.removeFile(filePath);
      } else {
        await this.indexer.updateFile(filePath);
      }
      filesIndexed = 1;
    } catch (err) {
      const description = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[Pluvianidae] Incremental indexing error in ${filePath}: ${description}`);
      errors.push({ filePath, description });
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > this.softTimeoutMs) {
      // Soft target per requirements.md 1.7: log and continue, do not abort
      // or discard the (already-completed) update.
      // eslint-disable-next-line no-console
      console.warn(
        `[Pluvianidae] Incremental update for ${filePath} took ${elapsed}ms, exceeding the ` +
          `${this.softTimeoutMs}ms target. The update was completed anyway.`,
      );
    }

    this.eventBus.emit({
      type: 'indexing:progress',
      payload: { current: 1, total: 1, currentFile: filePath },
    });
    this.eventBus.emit({ type: 'indexing:completed', payload: { filesIndexed, errors } });
  }

  watch(): Disposable {
    // Imported lazily so this module can be loaded (and its pure logic
    // unit-tested) in environments without a VS Code extension host; only
    // calling `watch()` requires `vscode` to be resolvable at runtime.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{js,jsx,ts,tsx}');

    const onCreate = watcher.onDidCreate((uri) => {
      void this.handleFileChange(uri.fsPath, 'create');
    });
    const onChange = watcher.onDidChange((uri) => {
      void this.handleFileChange(uri.fsPath, 'modify');
    });
    const onDelete = watcher.onDidDelete((uri) => {
      void this.handleFileChange(uri.fsPath, 'delete');
    });

    return {
      dispose: () => {
        onCreate.dispose();
        onChange.dispose();
        onDelete.dispose();
        watcher.dispose();
      },
    };
  }

  private isIndexableExtension(filePath: string): boolean {
    return INDEXABLE_EXTENSION_SET.has(path.extname(filePath));
  }

  /**
   * Mirrors `FileDiscovery`'s directory-name exclusion (node_modules,
   * bower_components, .pnp): true if any path segment of `filePath` is an
   * excluded directory name. Checked directly on the absolute path so it
   * works even before the repository root is known.
   */
  private isWithinExcludedDirectory(filePath: string): boolean {
    const segments = filePath.split(/[\\/]/);
    return segments.some((segment) => EXCLUDED_DIRECTORY_NAME_SET.has(segment));
  }

  /**
   * Applies `.gitignore` and Security Filter exclusion, mirroring
   * `FileDiscovery.walk`. Both checks need a path relative to the
   * repository root; if the underlying indexer has no root yet (no full
   * index has been built), these checks are skipped since there is nothing
   * meaningful to relate the path to.
   */
  private async isExcludedByGitignoreOrSecurityFilter(filePath: string): Promise<boolean> {
    const rootPath = this.indexer.getIndex().rootPath;
    if (!rootPath) {
      return false;
    }

    const relativePath = toPosixRelativePath(rootPath, filePath);

    const gitignorePatterns = await this.getGitignorePatterns(rootPath);
    if (matchesGitignore(relativePath, false, gitignorePatterns)) {
      return true;
    }
    // Directory-only patterns (e.g. `ignored/`) only match directory
    // entries directly, mirroring `FileDiscovery.walk`'s traversal-time
    // exclusion. Since incremental updates check a single file path
    // without walking the tree, ancestor directories must be checked
    // explicitly so files under an excluded directory are still excluded.
    if (this.isWithinExcludedAncestorDirectory(relativePath, gitignorePatterns)) {
      return true;
    }

    return this.securityFilter.shouldExclude(relativePath);
  }

  /**
   * Checks whether any ancestor directory of `relativePath` (a posix-style
   * path relative to the repository root) matches a directory-only
   * gitignore pattern (e.g. `ignored/`).
   */
  private isWithinExcludedAncestorDirectory(relativePath: string, patterns: GitignorePattern[]): boolean {
    const segments = relativePath.split('/');
    for (let i = 1; i < segments.length; i++) {
      const ancestorPath = segments.slice(0, i).join('/');
      if (matchesGitignore(ancestorPath, true, patterns)) {
        return true;
      }
    }
    return false;
  }

  private async getGitignorePatterns(rootPath: string): Promise<GitignorePattern[]> {
    if (this.gitignoreCache && this.gitignoreCache.rootPath === rootPath) {
      return this.gitignoreCache.patterns;
    }
    const patterns = await loadGitignorePatterns(rootPath);
    this.gitignoreCache = { rootPath, patterns };
    return patterns;
  }
}

function toPosixRelativePath(rootPath: string, fullPath: string): string {
  return path.relative(rootPath, fullPath).split(path.sep).join('/');
}
