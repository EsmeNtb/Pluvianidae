import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ReadmeGenerator,
  IReadmeConfirmationPrompt,
  FsReadmeFileSystem,
  ReadmeDraft,
  DEFAULT_README_FILENAME,
} from '../../../src/modules/readme-generator/readme-generator';
import { computeReadmeDiff } from '../../../src/modules/readme-generator/readme-diff';
import { IIndexer } from '../../../src/modules/indexer/index-builder';
import { BedrockContext, IBedrockClient } from '../../../src/services/bedrock-client';
import { EndpointEntry, FileEntry, RepositoryIndex } from '../../../src/core/models';

// ---------------------------------------------------------------------------
// Fixtures / stubs
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-readme-generator-'));
}

async function writeFile(root: string, relativePath: string, content = ''): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
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

class FakeIndexer implements Pick<IIndexer, 'getIndex'> {
  constructor(private readonly index: RepositoryIndex) {}
  getIndex(): RepositoryIndex {
    return this.index;
  }
}

class StubBedrockClient implements IBedrockClient {
  isAvailableMock = vi.fn<[], Promise<boolean>>();
  queryMock = vi.fn<[string, BedrockContext], Promise<string>>();

  async isAvailable(): Promise<boolean> {
    return this.isAvailableMock();
  }

  async query(prompt: string, context: BedrockContext): Promise<string> {
    return this.queryMock(prompt, context);
  }
}

/** Stub confirmation prompt: resolves to a fixed answer and records the draft/path it was asked to confirm. */
class StubConfirmationPrompt implements IReadmeConfirmationPrompt {
  public lastDraft: ReadmeDraft | undefined;
  public lastTargetPath: string | undefined;

  constructor(private readonly answer: boolean) {}

  async confirmWrite(draft: ReadmeDraft, targetPath: string): Promise<boolean> {
    this.lastDraft = draft;
    this.lastTargetPath = targetPath;
    return this.answer;
  }
}

describe('ReadmeGenerator.generateDraft', () => {
  let root: string;
  let bedrockClient: StubBedrockClient;

  beforeEach(async () => {
    root = await makeTempDir();
    bedrockClient = new StubBedrockClient();
    bedrockClient.isAvailableMock.mockResolvedValue(false); // default: Bedrock unavailable -> deterministic fallback
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('includes the tech stack section derived from package.json dependencies', async () => {
    await writeFile(
      root,
      'package.json',
      JSON.stringify({
        name: 'my-app',
        description: 'A test app',
        dependencies: { react: '^18.0.0', express: '^4.18.0' },
        devDependencies: { typescript: '^5.3.3' },
      }),
    );

    const index = makeEmptyIndex(root);
    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    const techSection = draft.sections.find((s) => s.title === 'Stack tecnológico');
    expect(techSection).toBeDefined();
    expect(techSection?.content).toContain('React (frontend)');
    expect(techSection?.content).toContain('Express (backend)');
    expect(techSection?.content).toContain('TypeScript');
    expect(draft.content).toContain('Stack tecnológico');
  });

  it('includes the scripts section derived from package.json scripts', async () => {
    await writeFile(
      root,
      'package.json',
      JSON.stringify({
        name: 'my-app',
        scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' },
      }),
    );

    const index = makeEmptyIndex(root);
    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    const scriptsSection = draft.sections.find((s) => s.title === 'Scripts disponibles');
    expect(scriptsSection).toBeDefined();
    expect(scriptsSection?.content).toContain('npm run dev');
    expect(scriptsSection?.content).toContain('vite build');
    expect(scriptsSection?.content).toContain('npm run test');
  });

  it('includes the folder structure section derived from the repository index', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app' }));

    const index = makeEmptyIndex(root);
    index.files.set('/repo/src/index.ts', makeFileEntry({ path: '/repo/src/index.ts', relativePath: 'src/index.ts' }));
    index.files.set(
      '/repo/src/utils/helper.ts',
      makeFileEntry({ path: '/repo/src/utils/helper.ts', relativePath: 'src/utils/helper.ts' }),
    );

    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    const folderSection = draft.sections.find((s) => s.title === 'Estructura de carpetas');
    expect(folderSection).toBeDefined();
    expect(folderSection?.content).toContain('src/');
    expect(folderSection?.content).toContain('utils/');
  });

  it('omits the env vars section with a reason when none are detected', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app' }));
    // No .env.example/.env.sample, and the (only) indexed file has no env var references.
    await writeFile(root, 'src/index.ts', `console.log('hello');\n`);

    const index = makeEmptyIndex(root);
    index.files.set(
      path.join(root, 'src/index.ts'),
      makeFileEntry({ path: path.join(root, 'src/index.ts'), relativePath: 'src/index.ts' }),
    );

    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    expect(draft.sections.find((s) => s.title === 'Variables de entorno')).toBeUndefined();
    const omitted = draft.omittedSections.find((s) => s.title === 'Variables de entorno');
    expect(omitted).toBeDefined();
    expect(omitted?.reason).toBe('No se detectaron variables de entorno.');
  });

  it('includes env var names (never values) from a .env.example file', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app' }));
    await writeFile(root, '.env.example', 'API_URL=\nDB_PASSWORD=supersecret123\n# a comment\n\nPORT=3000\n');

    const index = makeEmptyIndex(root);
    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    const envSection = draft.sections.find((s) => s.title === 'Variables de entorno');
    expect(envSection).toBeDefined();
    expect(envSection?.content).toContain('API_URL');
    expect(envSection?.content).toContain('DB_PASSWORD');
    expect(envSection?.content).toContain('PORT');
    expect(envSection?.content).not.toContain('supersecret123');
  });

  it('includes the endpoints section populated from the repository index', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app', dependencies: { express: '^4.18.0' } }));

    const index = makeEmptyIndex(root);
    const endpoint: EndpointEntry = {
      route: '/api/users',
      method: 'GET',
      filePath: path.join(root, 'src/routes/users.ts'),
      line: 10,
      parameters: [],
    };
    index.endpoints.push(endpoint);

    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    const endpointsSection = draft.sections.find((s) => s.title === 'Endpoints principales');
    expect(endpointsSection).toBeDefined();
    expect(endpointsSection?.content).toContain('GET');
    expect(endpointsSection?.content).toContain('/api/users');
    expect(draft.omittedSections.find((s) => s.title === 'Endpoints principales')).toBeUndefined();
  });

  it('omits the endpoints section with a reason when the index has none', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app' }));

    const index = makeEmptyIndex(root);
    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    const omitted = draft.omittedSections.find((s) => s.title === 'Endpoints principales');
    expect(omitted).toBeDefined();
    expect(omitted?.reason).toBe('No se detectaron endpoints backend.');
  });

  it('produces a draft with content, sections, and omittedSections present, and diff undefined by default', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app', description: 'Test project' }));

    const index = makeEmptyIndex(root);
    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    expect(typeof draft.content).toBe('string');
    expect(draft.content.length).toBeGreaterThan(0);
    expect(Array.isArray(draft.sections)).toBe(true);
    expect(Array.isArray(draft.omittedSections)).toBe(true);
    expect(draft.sections.length).toBeGreaterThan(0);
    expect(draft.diff).toBeUndefined();
  });

  it('uses the deterministic fallback description when Bedrock is unavailable', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app', description: 'A test app' }));
    bedrockClient.isAvailableMock.mockResolvedValue(false);

    const index = makeEmptyIndex(root);
    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    const descSection = draft.sections.find((s) => s.title === 'Descripción del proyecto');
    expect(descSection).toBeDefined();
    expect(descSection?.content).toContain('my-app');
    expect(descSection?.content).toContain('A test app');
    expect(bedrockClient.queryMock).not.toHaveBeenCalled();
  });

  it('uses the Bedrock-generated description when Bedrock is available', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app', description: 'A test app' }));
    bedrockClient.isAvailableMock.mockResolvedValue(true);
    bedrockClient.queryMock.mockResolvedValue('Una aplicación de prueba generada por Bedrock.');

    const index = makeEmptyIndex(root);
    const generator = new ReadmeGenerator(new FakeIndexer(index), bedrockClient, root, new FsReadmeFileSystem());
    const draft = await generator.generateDraft();

    const descSection = draft.sections.find((s) => s.title === 'Descripción del proyecto');
    expect(descSection?.content).toBe('Una aplicación de prueba generada por Bedrock.');
    expect(bedrockClient.queryMock).toHaveBeenCalledTimes(1);
  });

  it('populates diff via an injected ReadmeDiffComputer when an existing README differs from the draft', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app' }));
    await writeFile(root, DEFAULT_README_FILENAME, '# Old README\n\nOutdated content.\n');

    const index = makeEmptyIndex(root);
    const generator = new ReadmeGenerator(
      new FakeIndexer(index),
      bedrockClient,
      root,
      new FsReadmeFileSystem(),
      undefined,
      computeReadmeDiff,
    );
    const draft = await generator.generateDraft();

    expect(draft.diff).toBeDefined();
    expect(draft.diff).toContain('- # Old README');
  });
});

describe('ReadmeGenerator.applyDraft', () => {
  let root: string;
  let bedrockClient: StubBedrockClient;

  beforeEach(async () => {
    root = await makeTempDir();
    bedrockClient = new StubBedrockClient();
    bedrockClient.isAvailableMock.mockResolvedValue(false);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes the file to disk when the user confirms the draft', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app' }));

    const index = makeEmptyIndex(root);
    const prompt = new StubConfirmationPrompt(true);
    const generator = new ReadmeGenerator(
      new FakeIndexer(index),
      bedrockClient,
      root,
      new FsReadmeFileSystem(),
      prompt,
    );

    const draft = await generator.generateDraft();
    await generator.applyDraft(draft);

    const writtenPath = path.join(root, DEFAULT_README_FILENAME);
    const writtenContent = await fs.readFile(writtenPath, 'utf-8');
    expect(writtenContent).toBe(draft.content);
    expect(prompt.lastTargetPath).toBe(writtenPath);
  });

  it('passes the computed diff through to the confirmation prompt when an existing README differs', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app' }));
    await writeFile(root, DEFAULT_README_FILENAME, '# Old README\n\nOutdated content.\n');

    const index = makeEmptyIndex(root);
    const prompt = new StubConfirmationPrompt(false);
    const generator = new ReadmeGenerator(
      new FakeIndexer(index),
      bedrockClient,
      root,
      new FsReadmeFileSystem(),
      prompt,
      computeReadmeDiff,
    );

    const draft = await generator.generateDraft();
    await generator.applyDraft(draft);

    expect(prompt.lastDraft?.diff).toBeDefined();
    expect(prompt.lastDraft?.diff).toContain('- # Old README');
  });

  it('does not write and preserves the existing README when the user rejects the draft', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ name: 'my-app' }));
    const existingContent = '# Existing README\n\nDo not touch me.\n';
    await writeFile(root, DEFAULT_README_FILENAME, existingContent);

    const index = makeEmptyIndex(root);
    const prompt = new StubConfirmationPrompt(false);
    const generator = new ReadmeGenerator(
      new FakeIndexer(index),
      bedrockClient,
      root,
      new FsReadmeFileSystem(),
      prompt,
    );

    const draft = await generator.generateDraft();
    await generator.applyDraft(draft);

    const readmePath = path.join(root, DEFAULT_README_FILENAME);
    const contentAfter = await fs.readFile(readmePath, 'utf-8');
    expect(contentAfter).toBe(existingContent);
  });
});
