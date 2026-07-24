import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
} from '../../../src/modules/pre-commit-reviewer/pre-commit-reviewer';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-pre-commit-'));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/** Stub `IGitClient` returning fixed staged/untracked file lists. */
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

/** Stub `ICommandRunner` that never actually shells out — every check that depends on it is skipped instead. */
class StubCommandRunner implements ICommandRunner {
  async run(): Promise<CommandResult> {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

class StubSecretDetector implements ISecretDetector {
  constructor(private readonly result: SecretFinding[] = []) {}

  async detect(): Promise<SecretFinding[]> {
    return this.result;
  }
}

describe('PreCommitReviewer', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports the staged files exactly as returned by the git client', async () => {
    await writeFile(root, 'src/a.ts', `export const a = 1;\n`);
    const stagedPath = path.join(root, 'src', 'a.ts');

    const reviewer = new PreCommitReviewer(root, new StubGitClient([stagedPath]), new StubCommandRunner());
    const report = await reviewer.review();

    expect(report.stagedFiles).toEqual([stagedPath]);
  });

  it('detects a broken relative import as an error finding', async () => {
    await writeFile(root, 'src/broken.ts', `import { thing } from './does-not-exist';\nconsole.log(thing);\n`);
    const stagedPath = path.join(root, 'src', 'broken.ts');

    const reviewer = new PreCommitReviewer(root, new StubGitClient([stagedPath]), new StubCommandRunner());
    const report = await reviewer.review();

    const brokenImportFindings = report.findings.filter((f) => f.checkType === 'broken-imports');
    expect(brokenImportFindings).toHaveLength(1);
    expect(brokenImportFindings[0]).toMatchObject({
      severity: 'error',
      filePath: stagedPath,
      line: 1,
    });
  });

  it('reports an untracked file as a recomendación finding', async () => {
    const untrackedPath = path.join(root, 'src', 'forgotten.ts');

    const reviewer = new PreCommitReviewer(
      root,
      new StubGitClient([], [untrackedPath]),
      new StubCommandRunner(),
    );
    const report = await reviewer.review();

    const forgottenFindings = report.findings.filter((f) => f.checkType === 'forgotten-files');
    expect(forgottenFindings).toHaveLength(1);
    expect(forgottenFindings[0]).toMatchObject({
      severity: 'recomendación',
      filePath: untrackedPath,
    });
  });

  it('skips the compilation check with a reason when no tsconfig.json is present', async () => {
    // root has no tsconfig.json (temp dir starts empty).
    const reviewer = new PreCommitReviewer(root, new StubGitClient([]), new StubCommandRunner());
    const report = await reviewer.review();

    const skipped = report.skippedChecks.find((s) => s.name === 'compilation');
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toBeTruthy();
  });

  it('maps unused-code findings by confidence and filters them to staged files only', async () => {
    await writeFile(
      root,
      'src/utils.ts',
      `export function neverCalled(): void {\n  console.log('dead');\n}\n\nexport function used(): void {\n  console.log('alive');\n}\n`,
    );
    await writeFile(root, 'src/index.ts', `import { used } from './utils';\nused();\n`);
    const stagedPath = path.join(root, 'src', 'utils.ts');

    const reviewer = new PreCommitReviewer(root, new StubGitClient([stagedPath]), new StubCommandRunner());
    const report = await reviewer.review();

    const unusedCodeFindings = report.findings.filter((f) => f.checkType === 'unused-code');
    // Only findings for the staged file (utils.ts) should appear, not for index.ts.
    expect(unusedCodeFindings.every((f) => f.filePath === stagedPath)).toBe(true);
    const neverCalledFinding = unusedCodeFindings.find((f) => f.description.includes('neverCalled'));
    expect(neverCalledFinding).toBeDefined();
    // DeadCodeDetector reports zero-reference functions with confidence "alto" -> mapped to "advertencia".
    expect(neverCalledFinding?.severity).toBe('advertencia');
  });

  it('returns a well-shaped report with all expected arrays present and a boolean timedOut flag', async () => {
    await writeFile(root, 'src/a.ts', `export const a = 1;\n`);
    const stagedPath = path.join(root, 'src', 'a.ts');

    const reviewer = new PreCommitReviewer(
      root,
      new StubGitClient([stagedPath]),
      new StubCommandRunner(),
      new StubSecretDetector(),
    );
    const report = await reviewer.review();

    expect(Array.isArray(report.findings)).toBe(true);
    expect(Array.isArray(report.secretsDetected)).toBe(true);
    expect(Array.isArray(report.skippedChecks)).toBe(true);
    expect(Array.isArray(report.stagedFiles)).toBe(true);
    expect(Array.isArray(report.completedChecks)).toBe(true);
    expect(typeof report.timedOut).toBe('boolean');
    expect(report.timedOut).toBe(false);
    expect(report.secretsDetected).toEqual([]);
    // All checks should have completed well within the timeout for this trivial repo.
    expect(report.completedChecks.length).toBeGreaterThan(0);
    expect(report.incompleteChecks).toBeUndefined();
  });
});
