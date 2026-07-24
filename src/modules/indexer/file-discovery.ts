/**
 * File discovery and filtering for the Indexador module.
 *
 * Scans a repository root for indexable JavaScript/TypeScript source files,
 * applying three layers of exclusion:
 *   1. Dependency folders (node_modules, bower_components, .pnp) — never
 *      descended into.
 *   2. `.gitignore` patterns (when a `.gitignore` file exists at the
 *      repository root).
 *   3. The Security Filter service, which excludes sensitive files
 *      (.env*, *.pem, *secret*, etc.) from all analysis.
 *
 * See design.md > "3. Indexador (`modules/indexer/`)" and requirements.md >
 * "Requirement 1: Indexación del repositorio" (1.1, 1.3, 1.4).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ISecurityFilter, SecurityFilter } from '../../services/security-filter';

export interface IFileDiscovery {
  /** Returns the absolute paths of all files that should be indexed under `rootPath`. */
  discoverFiles(rootPath: string): Promise<string[]>;
}

/** File extensions the Indexador analyzes, per requirements.md 1.1. */
export const INDEXABLE_EXTENSIONS: readonly string[] = ['.js', '.jsx', '.ts', '.tsx'];

/** Dependency folders that are never descended into, per requirements.md 1.1. */
export const EXCLUDED_DIRECTORY_NAMES: readonly string[] = ['node_modules', 'bower_components', '.pnp'];

const INDEXABLE_EXTENSION_SET = new Set(INDEXABLE_EXTENSIONS);
const EXCLUDED_DIRECTORY_NAME_SET = new Set(EXCLUDED_DIRECTORY_NAMES);

// ---------------------------------------------------------------------------
// .gitignore parsing
// ---------------------------------------------------------------------------

export interface GitignorePattern {
  regex: RegExp;
  directoryOnly: boolean;
}

/**
 * Converts a glob fragment (a single gitignore pattern, without leading `/`
 * or trailing `/`) into an equivalent regex source string. Supports `*`
 * (any run of characters except `/`), `**` (any run of characters including
 * `/`), and `?` (single character except `/`). All other regex
 * metacharacters are escaped literally.
 */
function globFragmentToRegexSource(pattern: string): string {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++; // consume the second '*'
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      source += '\\' + char;
    } else {
      source += char;
    }
  }
  return source;
}

/**
 * Parses `.gitignore` file content into a list of matchable patterns.
 *
 * Supports: exact names, `*`/`?` wildcards, directory-only patterns (trailing
 * `/`), and root-anchored patterns (leading `/`). Blank lines and `#`
 * comments are skipped. Negation (`!`) patterns are recognized but skipped
 * (treated as a no-op) since re-inclusion is not required for the MVP.
 */
export function parseGitignore(content: string): GitignorePattern[] {
  const patterns: GitignorePattern[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) {
      continue;
    }

    let fragment = line;
    const directoryOnly = fragment.endsWith('/');
    if (directoryOnly) {
      fragment = fragment.slice(0, -1);
    }

    const anchored = fragment.startsWith('/');
    if (anchored) {
      fragment = fragment.slice(1);
    }

    if (fragment.length === 0) {
      continue;
    }

    const isPathPattern = anchored || fragment.includes('/');
    const regexSource = globFragmentToRegexSource(fragment);
    const regex = isPathPattern
      ? new RegExp('^' + regexSource + '(/.*)?$')
      : new RegExp('(^|/)' + regexSource + '(/.*)?$');

    patterns.push({ regex, directoryOnly });
  }

  return patterns;
}

/**
 * Determines whether `relativePath` (posix-style, relative to the repository
 * root, no leading slash) is excluded by any of the given gitignore
 * patterns. `isDirectory` distinguishes directory entries so that
 * directory-only patterns (e.g. `build/`) only match directories; excluding
 * a directory during traversal implicitly excludes everything beneath it.
 */
export function matchesGitignore(relativePath: string, isDirectory: boolean, patterns: GitignorePattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.directoryOnly && !isDirectory) {
      continue;
    }
    if (pattern.regex.test(relativePath)) {
      return true;
    }
  }
  return false;
}

export async function loadGitignorePatterns(rootPath: string): Promise<GitignorePattern[]> {
  try {
    const content = await fs.readFile(path.join(rootPath, '.gitignore'), 'utf-8');
    return parseGitignore(content);
  } catch {
    // No .gitignore present (or unreadable) — skip gitignore filtering entirely.
    return [];
  }
}

function toPosixRelativePath(rootPath: string, fullPath: string): string {
  return path.relative(rootPath, fullPath).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// FileDiscovery
// ---------------------------------------------------------------------------

export class FileDiscovery implements IFileDiscovery {
  private readonly securityFilter: ISecurityFilter;

  constructor(securityFilter: ISecurityFilter = new SecurityFilter()) {
    this.securityFilter = securityFilter;
  }

  async discoverFiles(rootPath: string): Promise<string[]> {
    const gitignorePatterns = await loadGitignorePatterns(rootPath);
    const results: string[] = [];
    await this.walk(rootPath, rootPath, gitignorePatterns, results);
    return results;
  }

  private async walk(
    dir: string,
    rootPath: string,
    gitignorePatterns: GitignorePattern[],
    results: string[],
  ): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, race condition, etc.) — skip it.
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = toPosixRelativePath(rootPath, fullPath);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAME_SET.has(entry.name)) {
          continue;
        }
        if (matchesGitignore(relativePath, true, gitignorePatterns)) {
          continue;
        }
        await this.walk(fullPath, rootPath, gitignorePatterns, results);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name);
      if (!INDEXABLE_EXTENSION_SET.has(extension)) {
        continue;
      }

      if (matchesGitignore(relativePath, false, gitignorePatterns)) {
        continue;
      }

      if (this.securityFilter.shouldExclude(relativePath)) {
        continue;
      }

      results.push(fullPath);
    }
  }
}
