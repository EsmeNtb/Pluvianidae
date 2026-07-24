import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DeadCodeFinding } from '../../../src/modules/dead-code-detector/dead-code-detector';
import {
  AutoFixService,
  FsFileEditor,
  IFileEditor,
  IFixConfirmationPrompt,
  ProposedFix,
} from '../../../src/modules/dead-code-detector/fix-confirmation';

/** Stub confirmation prompt: resolves to a fixed answer and records the fix it was asked to confirm. */
class StubConfirmationPrompt implements IFixConfirmationPrompt {
  public lastFix: ProposedFix | undefined;

  constructor(private readonly answer: boolean) {}

  async confirmFix(fix: ProposedFix): Promise<boolean> {
    this.lastFix = fix;
    return this.answer;
  }
}

/** In-memory file editor stub, for tests that shouldn't touch the real filesystem. */
class InMemoryFileEditor implements IFileEditor {
  constructor(private files: Map<string, string>) {}

  async readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined) {
      throw new Error(`File not found: ${filePath}`);
    }
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  async deleteFile(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }

  get(filePath: string): string | undefined {
    return this.files.get(filePath);
  }
}

function makeFinding(overrides: Partial<DeadCodeFinding>): DeadCodeFinding {
  return {
    type: 'unused-import',
    confidence: 'alto',
    filePath: '/repo/src/index.ts',
    line: 2,
    description: 'El import "subtract" no se utiliza en este archivo.',
    suggestedAction: 'eliminar',
    ...overrides,
  };
}

describe('AutoFixService.proposeFix', () => {
  it('proposes a line-deletion preview for an "eliminar" unused-import finding', async () => {
    const filePath = '/repo/src/index.ts';
    const files = new Map<string, string>([
      [filePath, `import { add } from './math';\nimport { subtract } from './math';\nconsole.log(add(1, 2));\n`],
    ]);
    const editor = new InMemoryFileEditor(files);
    const service = new AutoFixService(editor, new StubConfirmationPrompt(true));

    const finding = makeFinding({ type: 'unused-import', suggestedAction: 'eliminar', line: 2 });
    const fix = await service.proposeFix(finding);

    expect(fix).toBeDefined();
    expect(fix?.filePath).toBe(filePath);
    expect(fix?.preview).toContain("import { subtract } from './math';");
    expect(fix?.preview).toContain('(línea eliminada)');
  });

  it('proposes a comment-wrapped preview for a "comentar" finding', async () => {
    const filePath = '/repo/src/greet.ts';
    const files = new Map<string, string>([
      [filePath, `export function greet(name) {\n  const unused = 5;\n  return name;\n}\n`],
    ]);
    const editor = new InMemoryFileEditor(files);
    const service = new AutoFixService(editor, new StubConfirmationPrompt(true));

    const finding = makeFinding({
      type: 'unused-variable',
      suggestedAction: 'comentar',
      confidence: 'medio',
      filePath,
      line: 2,
      description: 'La variable "unused" no se utiliza en este archivo.',
    });
    const fix = await service.proposeFix(finding);

    expect(fix).toBeDefined();
    expect(fix?.preview).toContain('const unused = 5;');
    expect(fix?.preview).toContain('// const unused = 5;');
  });

  it('preserves leading indentation when commenting out a line', async () => {
    const filePath = '/repo/src/nested.ts';
    const files = new Map<string, string>([[filePath, `function f() {\n    const x = 1;\n}\n`]]);
    const editor = new InMemoryFileEditor(files);
    const service = new AutoFixService(editor, new StubConfirmationPrompt(true));

    const finding = makeFinding({
      type: 'unused-variable',
      suggestedAction: 'comentar',
      confidence: 'medio',
      filePath,
      line: 2,
    });
    const fix = await service.proposeFix(finding);

    expect(fix?.preview).toContain('    // const x = 1;');
  });

  it('returns undefined (no proposed fix) for "revisar-manualmente" findings', async () => {
    const editor = new InMemoryFileEditor(new Map());
    const service = new AutoFixService(editor, new StubConfirmationPrompt(true));

    const finding = makeFinding({
      type: 'orphan-file',
      suggestedAction: 'revisar-manualmente',
      confidence: 'alto',
      filePath: '/repo/src/orphan.ts',
      line: 1,
    });
    const fix = await service.proposeFix(finding);

    expect(fix).toBeUndefined();
  });

  it('proposes a whole-file deletion preview for an "eliminar" orphan-file finding', async () => {
    const filePath = '/repo/src/orphan.ts';
    const editor = new InMemoryFileEditor(new Map());
    const service = new AutoFixService(editor, new StubConfirmationPrompt(true));

    const finding = makeFinding({
      type: 'orphan-file',
      suggestedAction: 'eliminar',
      confidence: 'alto',
      filePath,
      line: 1,
      description: `El archivo "${filePath}" no es importado ni referenciado por ningún otro archivo del repositorio.`,
    });
    const fix = await service.proposeFix(finding);

    expect(fix).toBeDefined();
    expect(fix?.filePath).toBe(filePath);
    expect(fix?.preview).toContain('eliminado');
  });
});

describe('AutoFixService.applyFix', () => {
  it('modifies the file when the user confirms the fix (in-memory)', async () => {
    const filePath = '/repo/src/index.ts';
    const files = new Map<string, string>([
      [filePath, `import { add } from './math';\nimport { subtract } from './math';\nconsole.log(add(1, 2));\n`],
    ]);
    const editor = new InMemoryFileEditor(files);
    const service = new AutoFixService(editor, new StubConfirmationPrompt(true));

    const finding = makeFinding({ type: 'unused-import', suggestedAction: 'eliminar', line: 2, filePath });
    const fix = await service.proposeFix(finding);
    const result = await service.applyFix(fix!);

    expect(result.outcome).toBe('applied');
    const updated = editor.get(filePath);
    expect(updated).not.toContain('subtract');
    expect(updated).toContain("import { add } from './math';");
  });

  it('leaves the file unmodified when the user rejects the confirmation', async () => {
    const filePath = '/repo/src/index.ts';
    const original = `import { add } from './math';\nimport { subtract } from './math';\nconsole.log(add(1, 2));\n`;
    const files = new Map<string, string>([[filePath, original]]);
    const editor = new InMemoryFileEditor(files);
    const prompt = new StubConfirmationPrompt(false);
    const service = new AutoFixService(editor, prompt);

    const finding = makeFinding({ type: 'unused-import', suggestedAction: 'eliminar', line: 2, filePath });
    const fix = await service.proposeFix(finding);
    const result = await service.applyFix(fix!);

    expect(result.outcome).toBe('rejected');
    expect(editor.get(filePath)).toBe(original);
    expect(prompt.lastFix).toBe(fix);
  });

  it('applies a "comentar" fix by prefixing the line with a comment marker', async () => {
    const filePath = '/repo/src/greet.ts';
    const original = `export function greet(name) {\n  const unused = 5;\n  return name;\n}\n`;
    const files = new Map<string, string>([[filePath, original]]);
    const editor = new InMemoryFileEditor(files);
    const service = new AutoFixService(editor, new StubConfirmationPrompt(true));

    const finding = makeFinding({
      type: 'unused-variable',
      suggestedAction: 'comentar',
      confidence: 'medio',
      filePath,
      line: 2,
    });
    const fix = await service.proposeFix(finding);
    const result = await service.applyFix(fix!);

    expect(result.outcome).toBe('applied');
    const updated = editor.get(filePath);
    expect(updated).toContain('  // const unused = 5;');
  });

  it('reports an error outcome (without throwing) when the target line no longer exists', async () => {
    const filePath = '/repo/src/index.ts';
    const editor = new InMemoryFileEditor(new Map([[filePath, `console.log('only one line');\n`]]));
    const service = new AutoFixService(editor, new StubConfirmationPrompt(true));

    const finding = makeFinding({ type: 'unused-import', suggestedAction: 'eliminar', line: 99, filePath });
    // Bypass proposeFix (which would also fail reading line 99) to directly
    // exercise applyFix's own bounds check with a hand-built fix.
    const fix: ProposedFix = {
      finding,
      filePath,
      description: finding.description,
      preview: '- (n/a)\n+ (línea eliminada)',
    };
    const result = await service.applyFix(fix);

    expect(result.outcome).toBe('error');
    expect(result.message).toBeDefined();
  });
});

describe('AutoFixService end-to-end with the real filesystem', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-fix-confirmation-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('deletes the unused-import line on disk when the fix is confirmed', async () => {
    const filePath = path.join(root, 'index.ts');
    await fs.writeFile(
      filePath,
      `import { add } from './math';\nimport { subtract } from './math';\nconsole.log(add(1, 2));\n`,
      'utf-8',
    );

    const service = new AutoFixService(new FsFileEditor(), new StubConfirmationPrompt(true));
    const finding = makeFinding({ type: 'unused-import', suggestedAction: 'eliminar', line: 2, filePath });
    const fix = await service.proposeFix(finding);
    const result = await service.applyFix(fix!);

    expect(result.outcome).toBe('applied');
    const contentAfter = await fs.readFile(filePath, 'utf-8');
    expect(contentAfter).not.toContain('subtract');
    expect(contentAfter.split(/\r?\n/)).toHaveLength(3); // 2 remaining lines + trailing empty from join
  });

  it('deletes the whole file on disk for a confirmed orphan-file "eliminar" fix', async () => {
    const filePath = path.join(root, 'orphan.ts');
    await fs.writeFile(filePath, `export const unused = 1;\n`, 'utf-8');

    const service = new AutoFixService(new FsFileEditor(), new StubConfirmationPrompt(true));
    const finding = makeFinding({
      type: 'orphan-file',
      suggestedAction: 'eliminar',
      confidence: 'alto',
      filePath,
      line: 1,
    });
    const fix = await service.proposeFix(finding);
    const result = await service.applyFix(fix!);

    expect(result.outcome).toBe('applied');
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('leaves the file on disk untouched when the user rejects an orphan-file deletion', async () => {
    const filePath = path.join(root, 'orphan.ts');
    await fs.writeFile(filePath, `export const unused = 1;\n`, 'utf-8');

    const service = new AutoFixService(new FsFileEditor(), new StubConfirmationPrompt(false));
    const finding = makeFinding({
      type: 'orphan-file',
      suggestedAction: 'eliminar',
      confidence: 'alto',
      filePath,
      line: 1,
    });
    const fix = await service.proposeFix(finding);
    const result = await service.applyFix(fix!);

    expect(result.outcome).toBe('rejected');
    const contentAfter = await fs.readFile(filePath, 'utf-8');
    expect(contentAfter).toBe(`export const unused = 1;\n`);
  });
});
