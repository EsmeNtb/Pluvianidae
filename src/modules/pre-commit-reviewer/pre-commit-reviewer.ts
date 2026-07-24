/**
 * Revisor Pre-Commit (`modules/pre-commit-reviewer/`).
 *
 * Runs a battery of checks over the files currently staged for commit and
 * produces a classified `PreCommitReport`. See design.md > "8. Revisor
 * Pre-Commit (`modules/pre-commit-reviewer/`)" and requirements.md >
 * Requirement 6 (6.1, 6.2, 6.4, 6.5).
 *
 * Design deviations / interpretation decisions (documented here rather than
 * being silent, arbitrary changes):
 *
 *   1. **Git integration: CLI vs VS Code git API** — design.md says
 *      "Integrar con VS Code git API to get staged files". This
 *      implementation instead shells out to the `git` CLI directly (via
 *      Node's `child_process`, assuming `git` is available on PATH) behind
 *      an injectable `IGitClient` interface. This is functionally
 *      equivalent (both ultimately read the same staging area) but far more
 *      testable/portable outside a VS Code extension host — the VS Code
 *      git extension API requires a running extension host and its own
 *      activation lifecycle, which would make this module unusable in
 *      plain Vitest unit tests. `IGitClient` is injectable precisely so a
 *      future VS Code-git-API-backed implementation could be swapped in
 *      without touching the rest of this file.
 *
 *   2. **Forgotten files heuristic (6.1 "archivos olvidados")** — rather
 *      than trying to correlate untracked files with the staged set (e.g.
 *      "this staged file references a sibling that wasn't staged", which
 *      would require real static analysis and is overengineering for the
 *      MVP), every untracked file reported by `git status --porcelain`
 *      (lines starting with `??`) is surfaced as its own `recomendación`
 *      finding suggesting the user check whether it should be part of the
 *      commit.
 *
 *   3. **60-second timeout mechanism (6.5)** — all checks are started
 *      concurrently. Each check's promise, when it settles, immediately
 *      records its outcome into a results map (a side effect that happens
 *      independently of whether the overall race below has already timed
 *      out). `Promise.race` is used between "all checks settled" and an
 *      overall timer for the remaining budget; whichever resolves first
 *      decides `timedOut`. Because outcomes are recorded via the side
 *      effect as soon as each check individually finishes, the results map
 *      always reflects exactly which checks had completed by the time the
 *      race was decided, regardless of which arm of the race won. Checks
 *      still in flight when the timer wins keep running in the background
 *      (there is no cooperative cancellation for spawned subprocesses in
 *      this MVP) but their eventual results are simply not awaited or
 *      included in the returned report — `review()` returns as soon as the
 *      race is decided.
 *
 *   4. **Secret detection placeholder (task 10.2 integration point)** —
 *      `secretsDetected` is produced by an injected `ISecretDetector`
 *      (`detect(stagedFiles): Promise<SecretFinding[]>`), defaulting to
 *      `NoOpSecretDetector`, which always returns `[]`. This mirrors how
 *      `dead-code-detector.ts` (task 7.1) left `warnings: []` for
 *      `code-warnings.ts` (task 7.2) to populate. Task 10.2
 *      (`secret-detector.ts`) implements the real pattern-matching
 *      detector and the commit-blocking UX (requirements.md 6.3); it only
 *      needs to provide a class implementing `ISecretDetector` and pass an
 *      instance into this constructor — no changes to this file's checks
 *      are required.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { spawn } from 'child_process';
import { DeadCodeDetector, DeadCodeFinding, IDeadCodeDetector } from '../dead-code-detector/dead-code-detector';
import { IIndexer, IndexBuilder } from '../indexer/index-builder';

// ---------------------------------------------------------------------------
// Public interface & report shapes (design.md > "8. Revisor Pre-Commit")
// ---------------------------------------------------------------------------

export interface IPreCommitReviewer {
  review(): Promise<PreCommitReport>;
}

export interface PreCommitReport {
  findings: PreCommitFinding[];
  secretsDetected: SecretFinding[];
  skippedChecks: SkippedCheck[];
  stagedFiles: string[];
  timedOut: boolean;
  completedChecks: string[];
  incompleteChecks?: string[];
}

export type PreCommitSeverity = 'error' | 'advertencia' | 'recomendación';

export interface PreCommitFinding {
  severity: PreCommitSeverity;
  checkType: string;
  filePath: string;
  line: number;
  description: string;
}

export interface SecretFinding {
  filePath: string;
  line: number;
  /** tipo de secreto detectado */
  pattern: string;
}

export interface SkippedCheck {
  name: string;
  reason: string;
}

/** Requirements.md 6.5: hard 60-second budget for the whole review. */
export const PRE_COMMIT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Injectable git integration (see class-level doc comment #1)
// ---------------------------------------------------------------------------

export interface IGitClient {
  /** Absolute paths of files currently in the git staging area. */
  getStagedFiles(): Promise<string[]>;
  /** Absolute paths of untracked files (git status `??` entries). */
  getUntrackedFiles(): Promise<string[]>;
}

/** Default `IGitClient` backed directly by the `git` CLI (assumed to be on PATH). */
export class CliGitClient implements IGitClient {
  constructor(private readonly cwd: string) {}

  async getStagedFiles(): Promise<string[]> {
    const result = await runProcess('git', ['diff', '--name-only', '--cached'], this.cwd);
    return parseLines(result.stdout).map((relative) => path.resolve(this.cwd, relative));
  }

  async getUntrackedFiles(): Promise<string[]> {
    const result = await runProcess('git', ['status', '--porcelain'], this.cwd);
    return parseLines(result.stdout)
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(2).trim())
      .filter((relative) => relative.length > 0)
      .map((relative) => path.resolve(this.cwd, relative));
  }
}

// ---------------------------------------------------------------------------
// Injectable command execution (linter / unit tests / compiler)
// ---------------------------------------------------------------------------

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ICommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

/**
 * Default `ICommandRunner` backed by `child_process.spawn`. Uses
 * `shell: true` so that `npx`/local `node_modules/.bin` shims resolve
 * consistently across platforms (notably Windows, where these are `.cmd`
 * files); this is a deliberate, documented tradeoff for the default
 * production implementation only — every check that uses this runner is
 * invoked with a fixed, hardcoded command name and arguments derived from
 * file paths already known to exist on disk (never raw, untrusted external
 * input), so shell-injection risk here is minimal. Unit tests for this
 * module inject a stub `ICommandRunner` instead of exercising this class.
 */
export class ChildProcessCommandRunner implements ICommandRunner {
  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    return runProcess(command, args, cwd);
  }
}

function runProcess(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    try {
      const child = spawn(command, args, { cwd, shell: true });
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        resolve({ stdout, stderr: stderr + String(err), exitCode: 1 });
      });
      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    } catch (err) {
      resolve({ stdout, stderr: stderr + String(err), exitCode: 1 });
    }
  });
}

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Secret detection integration point (see class-level doc comment #4)
// ---------------------------------------------------------------------------

export interface ISecretDetector {
  detect(stagedFiles: string[]): Promise<SecretFinding[]>;
}

/** Placeholder used until task 10.2 (`secret-detector.ts`) provides a real implementation. */
export class NoOpSecretDetector implements ISecretDetector {
  async detect(_stagedFiles: string[]): Promise<SecretFinding[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal per-check result shape
// ---------------------------------------------------------------------------

interface CheckOutcome {
  findings: PreCommitFinding[];
  secrets?: SecretFinding[];
  skipped?: SkippedCheck;
}

interface CheckDefinition {
  name: string;
  run: () => Promise<CheckOutcome>;
}

const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const RESOLVABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx'];
const ESLINT_CONFIG_FILENAMES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.mjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
  'eslint.config.ts',
];

// ---------------------------------------------------------------------------
// PreCommitReviewer
// ---------------------------------------------------------------------------

export class PreCommitReviewer implements IPreCommitReviewer {
  private readonly gitClient: IGitClient;
  private readonly commandRunner: ICommandRunner;
  private readonly secretDetector: ISecretDetector;
  private readonly indexer: Pick<IIndexer, 'indexRepository' | 'getIndex'>;
  private readonly deadCodeDetector: IDeadCodeDetector;
  private readonly timeoutMs: number;

  constructor(
    private readonly workspaceRoot: string,
    gitClient: IGitClient = new CliGitClient(workspaceRoot),
    commandRunner: ICommandRunner = new ChildProcessCommandRunner(),
    secretDetector: ISecretDetector = new NoOpSecretDetector(),
    indexer: Pick<IIndexer, 'indexRepository' | 'getIndex'> = new IndexBuilder(),
    deadCodeDetector: IDeadCodeDetector = new DeadCodeDetector(indexer),
    timeoutMs: number = PRE_COMMIT_TIMEOUT_MS,
  ) {
    this.gitClient = gitClient;
    this.commandRunner = commandRunner;
    this.secretDetector = secretDetector;
    this.indexer = indexer;
    this.deadCodeDetector = deadCodeDetector;
    this.timeoutMs = timeoutMs;
  }

  async review(): Promise<PreCommitReport> {
    const deadline = Date.now() + this.timeoutMs;

    let stagedFiles: string[] = [];
    let untrackedFiles: string[] = [];
    const skippedChecks: SkippedCheck[] = [];

    try {
      stagedFiles = await this.gitClient.getStagedFiles();
    } catch (err) {
      skippedChecks.push({
        name: 'staged-files-detection',
        reason: `No se pudo obtener la lista de archivos en staging: ${describeError(err)}`,
      });
    }

    try {
      untrackedFiles = await this.gitClient.getUntrackedFiles();
    } catch (err) {
      skippedChecks.push({
        name: 'forgotten-files',
        reason: `No se pudo obtener la lista de archivos sin seguimiento: ${describeError(err)}`,
      });
    }

    const stagedFileSet = new Set(stagedFiles);
    const checks = this.buildChecks(stagedFiles, untrackedFiles, stagedFileSet);

    const results = new Map<string, CheckOutcome>();
    const runs = checks.map((check) =>
      check
        .run()
        .then((outcome) => {
          results.set(check.name, outcome);
        })
        .catch((err) => {
          results.set(check.name, {
            findings: [],
            skipped: { name: check.name, reason: `Falló la verificación: ${describeError(err)}` },
          });
        }),
    );

    const remaining = Math.max(0, deadline - Date.now());
    const allSettled = Promise.all(runs).then(() => 'done' as const);
    const overallTimeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), remaining);
    });

    const raceOutcome = remaining === 0 ? 'timeout' : await Promise.race([allSettled, overallTimeout]);
    const timedOut = raceOutcome === 'timeout';

    const findings: PreCommitFinding[] = [];
    let secretsDetected: SecretFinding[] = [];
    const completedChecks: string[] = [];
    const incompleteChecks: string[] = [];

    for (const check of checks) {
      const outcome = results.get(check.name);
      if (!outcome) {
        incompleteChecks.push(check.name);
        continue;
      }
      completedChecks.push(check.name);
      findings.push(...outcome.findings);
      if (outcome.secrets) {
        secretsDetected = secretsDetected.concat(outcome.secrets);
      }
      if (outcome.skipped) {
        skippedChecks.push(outcome.skipped);
      }
    }

    const report: PreCommitReport = {
      findings,
      secretsDetected,
      skippedChecks,
      stagedFiles,
      timedOut,
      completedChecks,
    };
    if (incompleteChecks.length > 0) {
      report.incompleteChecks = incompleteChecks;
    }
    return report;
  }

  private buildChecks(
    stagedFiles: string[],
    untrackedFiles: string[],
    stagedFileSet: Set<string>,
  ): CheckDefinition[] {
    return [
      { name: 'linter', run: () => this.checkLinter(stagedFiles) },
      { name: 'unit-tests', run: () => this.checkUnitTests() },
      { name: 'compilation', run: () => this.checkCompilation() },
      { name: 'broken-imports', run: () => this.checkBrokenImports(stagedFiles) },
      { name: 'forgotten-files', run: () => this.checkForgottenFiles(untrackedFiles) },
      { name: 'unused-code', run: () => this.checkUnusedCode(stagedFileSet) },
      { name: 'secrets', run: () => this.checkSecrets(stagedFiles) },
    ];
  }

  // -------------------------------------------------------------------
  // Linter check (requirements.md 6.1, 6.4)
  // -------------------------------------------------------------------

  private async checkLinter(stagedFiles: string[]): Promise<CheckOutcome> {
    if (!this.hasEslintConfig()) {
      return {
        findings: [],
        skipped: { name: 'linter', reason: 'ESLint no está configurado (no se encontró archivo de configuración).' },
      };
    }
    if (!this.isPackageAvailable('eslint')) {
      return { findings: [], skipped: { name: 'linter', reason: 'ESLint no está instalado en el proyecto.' } };
    }

    const targets = stagedFiles.filter((f) => JS_TS_EXTENSIONS.has(path.extname(f)));
    if (targets.length === 0) {
      return { findings: [] };
    }

    const result = await this.commandRunner.run('npx', ['eslint', ...targets, '--format', 'json'], this.workspaceRoot);

    try {
      const parsed = JSON.parse(result.stdout) as Array<{
        filePath: string;
        messages: Array<{ severity: number; line: number; message: string; ruleId?: string | null }>;
      }>;
      const findings: PreCommitFinding[] = [];
      for (const fileResult of parsed) {
        for (const message of fileResult.messages) {
          findings.push({
            severity: message.severity >= 2 ? 'error' : 'advertencia',
            checkType: 'linter',
            filePath: fileResult.filePath,
            line: message.line || 1,
            description: message.ruleId ? `${message.message} (${message.ruleId})` : message.message,
          });
        }
      }
      return { findings };
    } catch {
      return {
        findings: [],
        skipped: { name: 'linter', reason: 'No se pudo interpretar la salida del linter.' },
      };
    }
  }

  private hasEslintConfig(): boolean {
    for (const filename of ESLINT_CONFIG_FILENAMES) {
      if (fs.existsSync(path.join(this.workspaceRoot, filename))) {
        return true;
      }
    }
    const packageJson = this.readPackageJson();
    return Boolean(packageJson && packageJson.eslintConfig);
  }

  // -------------------------------------------------------------------
  // Unit test check (requirements.md 6.1, 6.4)
  // -------------------------------------------------------------------

  private async checkUnitTests(): Promise<CheckOutcome> {
    const packageJson = this.readPackageJson();
    const testScript = packageJson?.scripts?.test as string | undefined;
    if (!testScript || testScript.includes('no test specified')) {
      return {
        findings: [],
        skipped: {
          name: 'unit-tests',
          reason: 'No hay pruebas unitarias configuradas (no se encontró un script "test" en package.json).',
        },
      };
    }
    if (!this.isPackageAvailable('vitest')) {
      return {
        findings: [],
        skipped: { name: 'unit-tests', reason: 'El framework de pruebas (vitest) no está instalado.' },
      };
    }

    const result = await this.commandRunner.run(
      'npx',
      ['vitest', 'run', '--reporter=json'],
      this.workspaceRoot,
    );

    try {
      const parsed = JSON.parse(result.stdout) as {
        testResults?: Array<{
          name: string;
          assertionResults?: Array<{
            status: string;
            fullName?: string;
            failureMessages?: string[];
            location?: { line?: number } | null;
          }>;
        }>;
      };
      const findings: PreCommitFinding[] = [];
      for (const testFile of parsed.testResults ?? []) {
        for (const assertion of testFile.assertionResults ?? []) {
          if (assertion.status !== 'failed') {
            continue;
          }
          findings.push({
            severity: 'error',
            checkType: 'unit-tests',
            filePath: testFile.name,
            line: assertion.location?.line ?? 1,
            description: assertion.failureMessages?.join(' ') || `Falló la prueba "${assertion.fullName ?? ''}".`,
          });
        }
      }
      return { findings };
    } catch {
      return {
        findings: [],
        skipped: { name: 'unit-tests', reason: 'No se pudo interpretar la salida de las pruebas unitarias.' },
      };
    }
  }

  // -------------------------------------------------------------------
  // Compilation check (requirements.md 6.1, 6.4)
  // -------------------------------------------------------------------

  private async checkCompilation(): Promise<CheckOutcome> {
    const tsconfigPath = path.join(this.workspaceRoot, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) {
      return {
        findings: [],
        skipped: { name: 'compilation', reason: 'No se encontró tsconfig.json; no es posible compilar el proyecto.' },
      };
    }
    if (!this.isPackageAvailable('typescript')) {
      return {
        findings: [],
        skipped: { name: 'compilation', reason: 'El compilador de TypeScript no está instalado.' },
      };
    }

    const result = await this.commandRunner.run('npx', ['tsc', '--noEmit'], this.workspaceRoot);
    const combined = `${result.stdout}\n${result.stderr}`;
    const pattern = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
    const findings: PreCommitFinding[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(combined)) !== null) {
      const [, rawFilePath, line, , code, message] = match;
      findings.push({
        severity: 'error',
        checkType: 'compilation',
        filePath: path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(this.workspaceRoot, rawFilePath),
        line: Number(line) || 1,
        description: `${code}: ${message}`,
      });
    }
    return { findings };
  }

  // -------------------------------------------------------------------
  // Broken imports check (requirements.md 6.1)
  // -------------------------------------------------------------------

  private async checkBrokenImports(stagedFiles: string[]): Promise<CheckOutcome> {
    const findings: PreCommitFinding[] = [];

    for (const filePath of stagedFiles) {
      if (!JS_TS_EXTENSIONS.has(path.extname(filePath))) {
        continue;
      }
      let sourceText: string;
      try {
        sourceText = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
      const imports = collectRelativeImportSpecifiers(sourceFile);

      for (const imp of imports) {
        if (!resolveRelativeImportOnDisk(filePath, imp.source)) {
          findings.push({
            severity: 'error',
            checkType: 'broken-imports',
            filePath,
            line: imp.line,
            description: `El import "${imp.source}" no se pudo resolver a ningún archivo existente.`,
          });
        }
      }
    }

    return { findings };
  }

  // -------------------------------------------------------------------
  // Forgotten files check (requirements.md 6.1) — see doc comment #2
  // -------------------------------------------------------------------

  private async checkForgottenFiles(untrackedFiles: string[]): Promise<CheckOutcome> {
    const findings: PreCommitFinding[] = untrackedFiles.map((filePath) => ({
      severity: 'recomendación',
      checkType: 'forgotten-files',
      filePath,
      line: 1,
      description: `El archivo "${filePath}" no está incluido en el staging area. Verifica si debería formar parte de este commit.`,
    }));
    return { findings };
  }

  // -------------------------------------------------------------------
  // Unused code check (requirements.md 6.1)
  // -------------------------------------------------------------------

  private async checkUnusedCode(stagedFileSet: Set<string>): Promise<CheckOutcome> {
    if (stagedFileSet.size === 0) {
      return { findings: [] };
    }

    await this.indexer.indexRepository(this.workspaceRoot);
    const report = await this.deadCodeDetector.analyze();

    const findings: PreCommitFinding[] = report.findings
      .filter((finding: DeadCodeFinding) => stagedFileSet.has(finding.filePath))
      .map((finding: DeadCodeFinding) => ({
        severity: finding.confidence === 'alto' ? 'advertencia' : 'recomendación',
        checkType: 'unused-code',
        filePath: finding.filePath,
        line: finding.line,
        description: finding.description,
      }));

    return { findings };
  }

  // -------------------------------------------------------------------
  // Secrets check (placeholder — see doc comment #4, wired in task 10.2)
  // -------------------------------------------------------------------

  private async checkSecrets(stagedFiles: string[]): Promise<CheckOutcome> {
    const secrets = await this.secretDetector.detect(stagedFiles);
    return { findings: [], secrets };
  }

  // -------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------

  private readPackageJson(): { scripts?: Record<string, string>; eslintConfig?: unknown } | undefined {
    try {
      const content = fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf-8');
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  private isPackageAvailable(packageName: string): boolean {
    try {
      require.resolve(`${packageName}/package.json`, { paths: [this.workspaceRoot] });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// AST helpers for broken-imports detection
// ---------------------------------------------------------------------------

interface RelativeImportSpecifier {
  source: string;
  line: number;
}

/**
 * Collects the module specifier string and 1-indexed line number of every
 * relative import (`import ... from './x'`, `export ... from './x'`, and
 * `require('./x')` calls) found in `sourceFile`. Bare/package specifiers
 * (not starting with `.`) are intentionally excluded — they are assumed
 * resolvable via node_modules and out of scope for this check.
 */
function collectRelativeImportSpecifiers(sourceFile: ts.SourceFile): RelativeImportSpecifier[] {
  const specifiers: RelativeImportSpecifier[] = [];

  const pushIfRelative = (node: ts.Node, moduleSpecifier: ts.Expression | undefined): void => {
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      return;
    }
    const source = moduleSpecifier.text;
    if (!source.startsWith('.')) {
      return;
    }
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    specifiers.push({ source, line: line + 1 });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      pushIfRelative(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      pushIfRelative(node, node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      pushIfRelative(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

/**
 * Attempts to resolve a relative import `source` (used from `fromFile`) to
 * an existing file on disk, trying the exact path, each of
 * `RESOLVABLE_EXTENSIONS` appended directly, and each extension appended to
 * an `index` file within a directory of that name — mirroring
 * `index-builder.ts`'s `resolveImportPath` resolution order, but checking
 * the real filesystem directly instead of a known-files set (this check
 * runs standalone over staged files, independent of any built
 * `RepositoryIndex`).
 */
function resolveRelativeImportOnDisk(fromFile: string, source: string): boolean {
  const baseDir = path.dirname(fromFile);
  const resolvedBase = path.resolve(baseDir, source);

  if (fs.existsSync(resolvedBase) && fs.statSync(resolvedBase).isFile()) {
    return true;
  }

  for (const ext of RESOLVABLE_EXTENSIONS) {
    if (fs.existsSync(resolvedBase + ext)) {
      return true;
    }
  }

  for (const ext of RESOLVABLE_EXTENSIONS) {
    if (fs.existsSync(path.join(resolvedBase, `index${ext}`))) {
      return true;
    }
  }

  return false;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
    case '.js':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
