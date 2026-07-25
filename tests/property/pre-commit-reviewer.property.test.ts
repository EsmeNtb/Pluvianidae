import { describe, it, afterEach, expect } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  PreCommitReviewer,
  IGitClient,
  ICommandRunner,
  CommandResult,
  ISecretDetector,
  SecretFinding,
  PreCommitFinding,
} from '../../src/modules/pre-commit-reviewer/pre-commit-reviewer';

/**
 * Stub `IGitClient` returning fixed staged/untracked file lists, mirroring
 * `tests/unit/pre-commit-reviewer/pre-commit-reviewer.test.ts`.
 */
class StubGitClient implements IGitClient {
  constructor(
    private readonly staged: string[],
    private readonly untracked: string[] = [],
  ) {}

  async getStagedFiles(): Promise<string[]> {
    return this.staged;
  }

  async getUntrackedFiles(): Promise<string[]> {
    return this.untracked;
  }
}

/**
 * Fake `ICommandRunner` that returns generated `tsc --noEmit` / `vitest
 * --reporter=json`-shaped output depending on which command is invoked, so
 * that `checkCompilation` and `checkUnitTests` can be driven with
 * arbitrary generated error/failure counts without ever spawning a real
 * process.
 */
class FakeCommandRunner implements ICommandRunner {
  constructor(
    private readonly tscStdout: string,
    private readonly vitestStdout: string,
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    if (args.includes('tsc')) {
      return { stdout: this.tscStdout, stderr: '', exitCode: this.tscStdout ? 1 : 0 };
    }
    if (args.includes('vitest')) {
      return { stdout: this.vitestStdout, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

class StubSecretDetector implements ISecretDetector {
  constructor(private readonly result: SecretFinding[] = []) {}

  async detect(): Promise<SecretFinding[]> {
    return this.result;
  }
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-pre-commit-prop-'));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/** Safe, syntactically-valid identifier generator (letters/digits only). */
const identifierArbitrary = fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,10}$/);
/** Safe single-line message text (no characters that could break the tsc-error regex or JSON encoding). */
const safeMessageArbitrary = fc.stringMatching(/^[a-zA-Z0-9 ]{3,30}$/);
/** Safe relative-looking file path fragment (no parentheses/colons/quotes). */
const safeFileFragmentArbitrary = fc.stringMatching(/^[a-z][a-zA-Z0-9_/]{2,20}$/);

const ALLOWED_SEVERITIES = ['error', 'advertencia', 'recomendación'];

function buildTscOutput(
  errors: { file: string; line: number; code: number; message: string }[],
): string {
  return errors
    .map((e) => `${e.file}(${e.line},1): error TS${e.code}: ${e.message}`)
    .join('\n');
}

function buildVitestOutput(
  failures: { file: string; line: number; message: string }[],
): string {
  const testResults = failures.map((f, idx) => ({
    name: f.file,
    assertionResults: [
      {
        status: 'failed',
        fullName: `test-${idx}`,
        failureMessages: [f.message],
        location: { line: f.line },
      },
    ],
  }));
  return JSON.stringify({ testResults });
}

describe('PreCommitReviewer property tests', () => {
  const tempDirsToClean: string[] = [];

  afterEach(async () => {
    while (tempDirsToClean.length > 0) {
      const dir = tempDirsToClean.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Feature: pluvianidae-mvp, Property 16: Pre-commit finding classification
  it('classifies every finding as error/advertencia/recomendación and includes checkType, filePath, line and description', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            file: safeFileFragmentArbitrary,
            line: fc.integer({ min: 1, max: 9999 }),
            code: fc.integer({ min: 1000, max: 9999 }),
            message: safeMessageArbitrary,
          }),
          { minLength: 0, maxLength: 3 },
        ),
        fc.array(
          fc.record({
            file: safeFileFragmentArbitrary,
            line: fc.integer({ min: 1, max: 9999 }),
            message: safeMessageArbitrary,
          }),
          { minLength: 0, maxLength: 3 },
        ),
        fc.array(safeFileFragmentArbitrary, { minLength: 0, maxLength: 3 }),
        fc.uniqueArray(identifierArbitrary, { minLength: 0, maxLength: 2 }),
        async (tscErrors, vitestFailures, untrackedFragments, deadFunctionNames) => {
          const root = await makeTempDir();
          tempDirsToClean.push(root);

          // Gate `checkCompilation`/`checkUnitTests` open: they bail out
          // early (with a `skippedChecks` entry, contributing no findings)
          // unless tsconfig.json exists and package.json declares a "test"
          // script — see pre-commit-reviewer.ts's hasEslintConfig-style
          // filesystem gates.
          await writeFile(root, 'tsconfig.json', '{}');
          await writeFile(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));

          // One real, genuinely-unused exported function per generated
          // name so `checkUnusedCode` produces "alto"-confidence findings
          // (mapped to "advertencia"), exercising a third distinct
          // severity value alongside "error" (compilation/unit-tests) and
          // "recomendación" (forgotten-files).
          const stagedFiles: string[] = [];
          for (let i = 0; i < deadFunctionNames.length; i++) {
            const relative = `src/dead${i}.ts`;
            await writeFile(
              root,
              relative,
              `export function ${deadFunctionNames[i]}(): void {\n  console.log('unused');\n}\n`,
            );
            stagedFiles.push(path.join(root, relative));
          }

          const untrackedFiles = untrackedFragments.map((fragment) => path.join(root, `${fragment}.ts`));

          const tscStdout = buildTscOutput(tscErrors);
          const vitestStdout = buildVitestOutput(vitestFailures);

          const reviewer = new PreCommitReviewer(
            root,
            new StubGitClient(stagedFiles, untrackedFiles),
            new FakeCommandRunner(tscStdout, vitestStdout),
            new StubSecretDetector([]),
          );

          const report = await reviewer.review();

          for (const finding of report.findings as PreCommitFinding[]) {
            expect(ALLOWED_SEVERITIES).toContain(finding.severity);
            expect(typeof finding.checkType).toBe('string');
            expect(finding.checkType.length).toBeGreaterThan(0);
            expect(typeof finding.filePath).toBe('string');
            expect(finding.filePath.length).toBeGreaterThan(0);
            expect(typeof finding.line).toBe('number');
            expect(Number.isFinite(finding.line)).toBe(true);
            expect(typeof finding.description).toBe('string');
            expect(finding.description.length).toBeGreaterThan(0);
          }
        },
      ),
      // Each iteration does real filesystem I/O (temp dir + fixture writes
      // + a full default-indexer pass for checkUnusedCode) plus an async
      // `review()` call, so the run count is kept moderate to bound total
      // runtime.
      { numRuns: 30 },
    );
  });
});
