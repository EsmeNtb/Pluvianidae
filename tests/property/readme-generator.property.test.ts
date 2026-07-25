import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as path from 'path';
import {
  ReadmeGenerator,
  IReadmeFileSystem,
} from '../../src/modules/readme-generator/readme-generator';
import { IIndexer } from '../../src/modules/indexer/index-builder';
import { BedrockContext, IBedrockClient } from '../../src/services/bedrock-client';
import { EndpointEntry, FileEntry, RepositoryIndex } from '../../src/core/models';

// ---------------------------------------------------------------------------
// Fixtures / stubs
//
// A fully in-memory `IReadmeFileSystem` (no real disk I/O) lets each
// property test iteration run fast, keeping `numRuns` at a level that
// exercises a wide combination of "data present/absent" flags without
// slowing down the suite.
// ---------------------------------------------------------------------------

class FakeReadmeFileSystem implements IReadmeFileSystem {
  constructor(private readonly files: Map<string, string>) {}

  async readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return content;
  }

  async fileExists(filePath: string): Promise<boolean> {
    return this.files.has(filePath);
  }

  async writeFile(): Promise<void> {
    throw new Error('writeFile is not used by generateDraft() and is not supported by this fake.');
  }
}

class FakeIndexer implements Pick<IIndexer, 'getIndex'> {
  constructor(private readonly index: RepositoryIndex) {}
  getIndex(): RepositoryIndex {
    return this.index;
  }
}

class StubBedrockClient implements IBedrockClient {
  async isAvailable(): Promise<boolean> {
    return false; // deterministic fallback path; the description section is not asserted on below.
  }
  async query(_prompt: string, _context: BedrockContext): Promise<string> {
    throw new Error('query() should not be called when isAvailable() resolves false.');
  }
}

function makeFileEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: '/repo/src/index.ts',
    relativePath: 'src/index.ts',
    extension: '.ts',
    lastModified: new Date(),
    symbols: [],
    imports: [],
    exports: [],
    ...overrides,
  };
}

function makeEmptyIndex(rootPath: string): RepositoryIndex {
  return {
    rootPath,
    files: new Map(),
    symbols: new Map(),
    importGraph: new Map(),
    exportGraph: new Map(),
    endpoints: [],
    lastUpdated: new Date(),
  };
}

const WORKSPACE_ROOT = path.join('repo-root');

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A dependency name recognized by `KNOWN_TECH_LABELS`, used to make the tech stack section present. */
const depNameArbitrary = fc.constantFrom('react', 'express', 'typescript', 'vitest');

const routeArbitrary = fc.stringMatching(/^\/[a-z]{1,8}$/);
const methodArbitrary = fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH');
const envVarNameArbitrary = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,10}$/);

const scenarioArbitrary = fc.record({
  techStackPresent: fc.boolean(),
  depName: depNameArbitrary,
  scriptsPresent: fc.boolean(),
  envVarsPresent: fc.boolean(),
  envVarName: envVarNameArbitrary,
  endpointsPresent: fc.boolean(),
  route: routeArbitrary,
  method: methodArbitrary,
});

describe('ReadmeGenerator property tests', () => {
  // Feature: pluvianidae-mvp, Property 25: README section omission for missing data
  it('omits a section (with a non-empty reason) exactly when its underlying data is absent, and includes it exactly when the data is present', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const files = new Map<string, string>();

        const pkg: { dependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
        if (scenario.techStackPresent) {
          pkg.dependencies = { [scenario.depName]: '^1.0.0' };
        }
        if (scenario.scriptsPresent) {
          pkg.scripts = { build: 'tsc' };
        }
        files.set(path.join(WORKSPACE_ROOT, 'package.json'), JSON.stringify(pkg));

        if (scenario.envVarsPresent) {
          files.set(path.join(WORKSPACE_ROOT, '.env.example'), `${scenario.envVarName}=\n`);
        }
        // When envVarsPresent is false, deliberately omit both
        // `.env.example`/`.env.sample` from `files` (fileExists() ->
        // false) and any indexed source file content referencing
        // `process.env`, so the fallback scan also finds nothing.

        const index = makeEmptyIndex(WORKSPACE_ROOT);
        // At least one indexed file, so unrelated sections (description,
        // folder structure) don't spuriously become "omitted" and muddy
        // the sections/omittedSections invariant being tested here.
        index.files.set(
          path.join(WORKSPACE_ROOT, 'src/index.ts'),
          makeFileEntry({ path: path.join(WORKSPACE_ROOT, 'src/index.ts'), relativePath: 'src/index.ts' }),
        );

        if (scenario.endpointsPresent) {
          const endpoint: EndpointEntry = {
            route: scenario.route,
            method: scenario.method,
            filePath: path.join(WORKSPACE_ROOT, 'src/routes.ts'),
            line: 1,
            parameters: [],
          };
          index.endpoints.push(endpoint);
        }

        const generator = new ReadmeGenerator(
          new FakeIndexer(index),
          new StubBedrockClient(),
          WORKSPACE_ROOT,
          new FakeReadmeFileSystem(files),
        );

        const draft = await generator.generateDraft();

        const sectionTitles = new Set(draft.sections.map((s) => s.title));
        const omittedByTitle = new Map(draft.omittedSections.map((s) => [s.title, s]));

        const checks: Array<[present: boolean, title: string]> = [
          [scenario.techStackPresent, 'Stack tecnológico'],
          [scenario.scriptsPresent, 'Scripts disponibles'],
          [scenario.envVarsPresent, 'Variables de entorno'],
          [scenario.endpointsPresent, 'Endpoints principales'],
        ];

        for (const [present, title] of checks) {
          if (present) {
            expect(sectionTitles.has(title)).toBe(true);
            expect(omittedByTitle.has(title)).toBe(false);
          } else {
            expect(sectionTitles.has(title)).toBe(false);
            const omitted = omittedByTitle.get(title);
            expect(omitted).toBeDefined();
            expect(typeof omitted?.reason).toBe('string');
            expect(omitted!.reason.length).toBeGreaterThan(0);
          }
        }
      }),
      // Fully in-memory filesystem/index fake -> no real disk I/O per
      // iteration, but `generateDraft()` still performs several `await`
      // hops (package.json read, env file probing, Bedrock
      // availability check), so `numRuns` is kept moderate rather than
      // the default 100.
      { numRuns: 30 },
    );
  });
});
