import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IndexBuilder } from '../../src/modules/indexer/index-builder';
import { IncrementalIndexer } from '../../src/modules/indexer/incremental';
import { RepositoryIndex } from '../../src/core/models';

/**
 * Small pool of unique, syntactically-valid file/function name fragments.
 * The last name in the pool is reserved for the generated change (the new
 * file for 'create', or the extra function appended for 'modify'); the rest
 * seed the initial repository (2-5 files, matching the task's guidance).
 */
const nameArbitrary = fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/);
const namesArbitrary = fc.uniqueArray(nameArbitrary, { minLength: 3, maxLength: 6 });
const changeTypeArbitrary = fc.constantFrom<'create' | 'modify' | 'delete'>('create', 'modify', 'delete');

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-incremental-consistency-'));
}

function fileContentFor(name: string): string {
  return `export function ${name}(): number { return 1; }\n`;
}

function symbolNamesFor(index: RepositoryIndex, filePath: string): string[] {
  const fileEntry = index.files.get(filePath);
  if (!fileEntry) {
    return [];
  }
  return Array.from(fileEntry.symbols)
    .map((id) => index.symbols.get(id)?.name)
    .filter((name): name is string => name !== undefined)
    .sort();
}

describe('Incremental index consistency property tests', () => {
  const tempDirsToClean: string[] = [];

  afterEach(async () => {
    while (tempDirsToClean.length > 0) {
      const dir = tempDirsToClean.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Feature: pluvianidae-mvp, Property 6: Incremental index consistency
  it('keeps the incrementally-updated index equivalent to a fresh full re-index of the current repository state, reprocessing only the affected file', async () => {
    await fc.assert(
      fc.asyncProperty(namesArbitrary, changeTypeArbitrary, async (names, changeType) => {
        const root = await makeTempDir();
        tempDirsToClean.push(root);

        const extraName = names[names.length - 1];
        const initialNames = names.slice(0, -1);

        for (const name of initialNames) {
          await fs.writeFile(path.join(root, `${name}.ts`), fileContentFor(name), 'utf-8');
        }

        // Full initial index, maintained incrementally from here on.
        const incrementalBuilder = new IndexBuilder();
        await incrementalBuilder.indexRepository(root);
        const incrementalIndexer = new IncrementalIndexer(incrementalBuilder);

        const targetName = initialNames[0];
        const targetPath = path.join(root, `${targetName}.ts`);

        // Snapshot of every OTHER file's symbol ids before the incremental
        // update. Used below (for the 'modify' case) to confirm that
        // IncrementalIndexer did not touch/reprocess unrelated files.
        const beforeIndex = incrementalBuilder.getIndex();
        const otherFilesSymbolIdsBefore = new Map<string, string[]>();
        for (const [filePath, fileEntry] of beforeIndex.files) {
          if (filePath !== targetPath) {
            otherFilesSymbolIdsBefore.set(filePath, [...fileEntry.symbols].sort());
          }
        }

        if (changeType === 'create') {
          const newPath = path.join(root, `${extraName}.ts`);
          await fs.writeFile(newPath, fileContentFor(extraName), 'utf-8');
          await incrementalIndexer.handleFileChange(newPath, 'create');
        } else if (changeType === 'modify') {
          const newContent = fileContentFor(targetName) + fileContentFor(extraName);
          await fs.writeFile(targetPath, newContent, 'utf-8');
          await incrementalIndexer.handleFileChange(targetPath, 'modify');
        } else {
          await fs.rm(targetPath);
          await incrementalIndexer.handleFileChange(targetPath, 'delete');
        }

        // Ground truth: a completely independent, fresh full re-index of
        // the repository's current on-disk state, built with a brand new
        // IndexBuilder so it shares no state with the incremental one.
        const freshBuilder = new IndexBuilder();
        await freshBuilder.indexRepository(root);

        const incrementalIndex = incrementalBuilder.getIndex();
        const freshIndex = freshBuilder.getIndex();

        // Same set of indexed files (order-independent).
        const incrementalPaths = Array.from(incrementalIndex.files.keys()).sort();
        const freshPaths = Array.from(freshIndex.files.keys()).sort();
        expect(incrementalPaths).toEqual(freshPaths);

        // Same logical set of symbol names per file (ids may legitimately
        // differ between the two independently-built indexes).
        for (const filePath of incrementalPaths) {
          expect(symbolNamesFor(incrementalIndex, filePath)).toEqual(symbolNamesFor(freshIndex, filePath));
        }

        // "Only the affected file was reprocessed": for a 'modify' change,
        // every other file's symbol ids in the incrementally-updated index
        // must be byte-for-byte identical to what they were right before
        // the update.
        if (changeType === 'modify') {
          for (const [filePath, symbolIdsBefore] of otherFilesSymbolIdsBefore) {
            const fileEntryAfter = incrementalIndex.files.get(filePath);
            expect(fileEntryAfter).toBeDefined();
            expect([...fileEntryAfter!.symbols].sort()).toEqual(symbolIdsBefore);
          }
        }
      }),
      // Real filesystem I/O (temp dir + file writes + one incremental and
      // two full indexing passes + cleanup) happens on every iteration,
      // same tradeoff documented on the other real-fs-backed property
      // tests in this suite (see indexer.property.test.ts): 20 runs across
      // 2-5 initial files and all three change types still covers a wide
      // range of scenarios without making the suite slow.
      { numRuns: 20 },
    );
  });
});
