import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { loadGitignorePatterns, matchesGitignore } from '../../src/modules/indexer/file-discovery';

/**
 * A single filesystem entry to create under the temp repository root for the
 * gitignore-exclusion property below. `name` is unique across all entries in
 * a given run (enforced via `fc.uniqueArray`'s selector), which is what lets
 * per-entry `.gitignore` patterns (exact-name or `name.*` wildcard) target
 * exactly one entry without accidentally matching another.
 */
interface GitignoreTestEntry {
  name: string;
  isDirectory: boolean;
  /** Only meaningful when `isDirectory` is false. */
  patternStyle: 'exact' | 'wildcard';
  ignored: boolean;
}

const simpleNameArbitrary = fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/);

const entryArbitrary: fc.Arbitrary<GitignoreTestEntry> = fc.record({
  name: simpleNameArbitrary,
  isDirectory: fc.boolean(),
  patternStyle: fc.constantFrom<'exact' | 'wildcard'>('exact', 'wildcard'),
  ignored: fc.boolean(),
});

const entriesArbitrary = fc.uniqueArray(entryArbitrary, {
  minLength: 1,
  maxLength: 8,
  selector: (entry) => entry.name,
});

/** For a file entry, the actual file name created on disk (unique extension per entry avoids cross-entry pattern collisions). */
function fileNameFor(entry: GitignoreTestEntry, index: number): string {
  return `${entry.name}.ext${index}`;
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-gitignore-prop-'));
}

describe('Indexador property tests', () => {
  const tempDirsToClean: string[] = [];

  afterEach(async () => {
    while (tempDirsToClean.length > 0) {
      const dir = tempDirsToClean.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Feature: pluvianidae-mvp, Property 3: Gitignore pattern exclusion
  it('excludes a file or directory if and only if it matches a pattern in .gitignore', async () => {
    await fc.assert(
      fc.asyncProperty(entriesArbitrary, async (entries) => {
        const root = await makeTempDir();
        tempDirsToClean.push(root);

        const gitignoreLines: string[] = [];

        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];

          if (entry.isDirectory) {
            await fs.mkdir(path.join(root, entry.name), { recursive: true });
            // Give the directory real contents so it's a genuine directory entry.
            await fs.writeFile(path.join(root, entry.name, 'inner.txt'), '', 'utf-8');
            if (entry.ignored) {
              gitignoreLines.push(`${entry.name}/`);
            }
          } else {
            const fileName = fileNameFor(entry, index);
            await fs.writeFile(path.join(root, fileName), '', 'utf-8');
            if (entry.ignored) {
              gitignoreLines.push(entry.patternStyle === 'exact' ? fileName : `${entry.name}.*`);
            }
          }
        }

        await fs.writeFile(path.join(root, '.gitignore'), gitignoreLines.join('\n'), 'utf-8');

        const patterns = await loadGitignorePatterns(root);

        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          const relativePath = entry.isDirectory ? entry.name : fileNameFor(entry, index);

          const excluded = matchesGitignore(relativePath, entry.isDirectory, patterns);

          expect(excluded).toBe(entry.ignored);
        }
      }),
      { numRuns: 100 }
    );
  });
});

import { SymbolExtractor } from '../../src/modules/indexer/symbol-extractor';

/**
 * Arbitrary generator for a small set of unique, syntactically-valid
 * JS/TS identifiers. Truly arbitrary source generation risks producing
 * invalid syntax, so instead we randomize WHICH identifiers appear and
 * build a small, guaranteed-valid TypeScript source string from a
 * template around them (see design.md > "3. Indexador" and the
 * Testing Strategy section on property-based testing).
 */
const uniqueIdentifiersArbitrary = (minLength: number, maxLength: number) =>
  fc.uniqueArray(fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,10}$/), { minLength, maxLength });

describe('SymbolExtractor property tests', () => {
  const extractor = new SymbolExtractor();

  // Feature: pluvianidae-mvp, Property 2: Symbol extraction completeness
  it('extracts every generated function and class declaration as a symbol', () => {
    fc.assert(
      fc.property(
        uniqueIdentifiersArbitrary(0, 5),
        uniqueIdentifiersArbitrary(0, 5),
        (functionNamesRaw, classNamesRaw) => {
          // Function and class names must not collide with each other,
          // otherwise the assertion below (name -> expected type) would be
          // ambiguous for a name appearing in both lists.
          const classNames = classNamesRaw.filter((name) => !functionNamesRaw.includes(name));
          const functionNames = functionNamesRaw;

          let source = '';
          for (const name of functionNames) {
            source += `export function ${name}() { return 1; }\n`;
          }
          for (const name of classNames) {
            source += `export class ${name} { method() { return 1; } }\n`;
          }

          const { symbols } = extractor.extractFromSource('/repo/generated.ts', source);
          const symbolsByName = new Map(symbols.map((s) => [s.name, s]));

          for (const name of functionNames) {
            const symbol = symbolsByName.get(name);
            expect(symbol).toBeDefined();
            expect(symbol?.type).toBe('function');
          }

          for (const name of classNames) {
            const symbol = symbolsByName.get(name);
            expect(symbol).toBeDefined();
            expect(symbol?.type).toBe('class');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: pluvianidae-mvp, Property 2: Symbol extraction completeness
  it('extracts every generated import specifier and named export', () => {
    fc.assert(
      fc.property(
        uniqueIdentifiersArbitrary(1, 5),
        uniqueIdentifiersArbitrary(0, 5),
        (importSpecifiersRaw, exportNamesRaw) => {
          // Export names are declared as `const <name> = 1;` locals, so they
          // must not collide with the imported specifiers (which are not
          // locally declared) to keep the generated source unambiguous.
          const exportNames = exportNamesRaw.filter((name) => !importSpecifiersRaw.includes(name));
          const importSpecifiers = importSpecifiersRaw;

          let source = `import { ${importSpecifiers.join(', ')} } from 'some-module';\n`;
          for (const name of exportNames) {
            source += `const ${name} = 1;\n`;
          }
          if (exportNames.length > 0) {
            source += `export { ${exportNames.join(', ')} };\n`;
          }

          const { imports, exports } = extractor.extractFromSource('/repo/generated-imports.ts', source);

          for (const specifier of importSpecifiers) {
            const found = imports.some((entry) => entry.specifiers.includes(specifier));
            expect(found).toBe(true);
          }

          for (const name of exportNames) {
            const found = exports.some((entry) => entry.name === name);
            expect(found).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

import { IndexBuilder } from '../../src/modules/indexer/index-builder';
import { ISymbolExtractor, SymbolExtractionResult } from '../../src/modules/indexer/symbol-extractor';

/**
 * Arbitrary generator for a small set of uniquely-named files, each
 * independently marked "valid" or "broken". Names are prefixed with `fn`
 * (mirroring the `dir`/`file` prefixing used by the Property 1 generator
 * above) so a randomly-generated fragment can never collide with a reserved
 * TypeScript keyword when used as a function name in the "valid" template
 * below.
 */
const errorResilienceNameFragment = fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/);
const errorResilienceFileArb = fc.record({
  name: errorResilienceNameFragment.map((s) => `fn${s}`),
  valid: fc.boolean(),
});
const errorResilienceFilesArb = fc.uniqueArray(errorResilienceFileArb, {
  minLength: 2,
  maxLength: 8,
  selector: (f) => f.name,
});

describe('IndexBuilder property tests', () => {
  // Feature: pluvianidae-mvp, Property 5: Error resilience across modules
  it('processes every valid file and logs an error for every broken file without ever throwing (Property 5)', async () => {
    await fc.assert(
      fc.asyncProperty(errorResilienceFilesArb, async (files) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-error-resilience-'));
        try {
          const brokenPaths = new Set<string>();
          const validPaths = new Set<string>();

          for (const file of files) {
            const fullPath = path.join(root, `${file.name}.ts`);
            if (file.valid) {
              await fs.writeFile(fullPath, `export function ${file.name}(): number { return 1; }\n`, 'utf-8');
              validPaths.add(fullPath);
            } else {
              // The file content is deliberately syntactically broken.
              // `ts.createSourceFile` rarely throws on malformed input in
              // practice though -- it produces a best-effort AST instead
              // (see index-builder.ts's class-level doc comment on this
              // exact tradeoff, and index-builder.test.ts's own
              // "skips a file that throws during extraction" unit test,
              // which takes the same approach). So what this property
              // actually exercises is IndexBuilder's try/catch around
              // per-file processing: a wrapping extractor below simulates a
              // real extractor exception for every path in `brokenPaths`,
              // regardless of its literal content, while delegating to the
              // real `SymbolExtractor` for every valid path.
              await fs.writeFile(fullPath, `function ${file.name}broken( {{{ unterminated\n`, 'utf-8');
              brokenPaths.add(fullPath);
            }
          }

          const realExtractor = new SymbolExtractor();
          const throwingExtractor: ISymbolExtractor = {
            extractFromSource(filePath: string, sourceText: string): SymbolExtractionResult {
              if (brokenPaths.has(filePath)) {
                throw new Error(`simulated syntax error in ${filePath}`);
              }
              return realExtractor.extractFromSource(filePath, sourceText);
            },
          };

          const builder = new IndexBuilder(undefined, throwingExtractor);

          // (c) indexRepository never throws regardless of how many files are broken,
          // and always returns a well-formed IndexResult covering every discovered file.
          const result = await builder.indexRepository(root);
          expect(result.totalFiles).toBe(files.length);
          expect(result.filesProcessed + result.errors.length).toBe(result.totalFiles);

          const index = builder.getIndex();
          const errorPaths = new Set(result.errors.map((e) => e.filePath));

          // (a) every valid file contributes at least one symbol to the index.
          for (const validPath of validPaths) {
            expect(index.files.has(validPath)).toBe(true);
            expect(index.files.get(validPath)!.symbols.length).toBeGreaterThan(0);
            expect(errorPaths.has(validPath)).toBe(false);
          }

          // (b) every broken file is reported in errors and absent from the index.
          for (const brokenPath of brokenPaths) {
            expect(errorPaths.has(brokenPath)).toBe(true);
            expect(index.files.has(brokenPath)).toBe(false);
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }),
      // Real filesystem I/O (temp dir + N file writes + real indexing walk +
      // cleanup) happens on every iteration, same tradeoff documented on the
      // Property 1 test above: 30 runs with up to 8 files each still covers a
      // wide range of valid/broken splits without making the suite slow.
      { numRuns: 30 },
    );
  });
});
