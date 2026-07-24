import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  RepositoryExplainer,
  RepositoryExplanation,
  FLOW_UNAVAILABLE_MESSAGE,
} from '../../../src/modules/explainer/explainer';
import { IIndexer } from '../../../src/modules/indexer/index-builder';
import { BedrockContext, IBedrockClient } from '../../../src/services/bedrock-client';
import { EndpointEntry, FileEntry, RepositoryIndex, SymbolEntry } from '../../../src/core/models';

// ---------------------------------------------------------------------------
// Fixtures / stubs
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-explainer-'));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
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

function makeEmptyIndex(rootPath: string): RepositoryIndex {
  return {
    rootPath,
    files: new Map<string, FileEntry>(),
    symbols: new Map<string, SymbolEntry>(),
    importGraph: new Map<string, string[]>(),
    exportGraph: new Map(),
    endpoints: [],
    lastUpdated: new Date(),
  };
}

function makeComponentSymbol(overrides: Partial<SymbolEntry> = {}): SymbolEntry {
  return {
    id: 'comp#App@1',
    name: 'App',
    type: 'component',
    filePath: '/repo/src/App.tsx',
    line: 1,
    column: 1,
    endLine: 10,
    ...overrides,
  };
}

function makeEndpoint(overrides: Partial<EndpointEntry> = {}): EndpointEntry {
  return {
    route: '/users',
    method: 'GET',
    filePath: '/repo/src/server.ts',
    line: 1,
    parameters: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepositoryExplainer', () => {
  let root: string;
  let bedrockClient: StubBedrockClient;

  beforeEach(async () => {
    root = await makeTempDir();
    bedrockClient = new StubBedrockClient();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('detects both frontend and backend stacks when present', async () => {
    await writeFile(
      root,
      'package.json',
      JSON.stringify({
        dependencies: { react: '^18.0.0', express: '^4.18.0' },
        devDependencies: { vitest: '^1.0.0' },
      }),
    );

    const index = makeEmptyIndex(root);
    index.symbols.set('comp#App@1', makeComponentSymbol({ filePath: path.join(root, 'src/App.tsx') }));
    index.endpoints.push(makeEndpoint({ filePath: path.join(root, 'src/server.ts') }));

    bedrockClient.isAvailableMock.mockResolvedValue(true);
    bedrockClient.queryMock.mockResolvedValue('El usuario navega la app React que llama al backend Express.');

    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root);
    const result = await explainer.explain();

    expect(result.frontendStack).toEqual(['react']);
    expect(result.backendStack).toEqual(['express']);
    expect(result.omittedSections).toEqual([]);
    expect(result.flowGenerationFailed).toBe(false);
    expect(result.applicationFlow).toContain('React');
  });

  it('omits the backend section with a reason for a frontend-only repository', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));

    const index = makeEmptyIndex(root);
    index.symbols.set('comp#App@1', makeComponentSymbol({ filePath: path.join(root, 'src/App.tsx') }));

    bedrockClient.isAvailableMock.mockResolvedValue(true);
    bedrockClient.queryMock.mockResolvedValue('Flujo de la app frontend.');

    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root);
    const result = await explainer.explain();

    expect(result.frontendStack).toEqual(['react']);
    expect(result.backendStack).toBeUndefined();
    expect(result.omittedSections).toEqual([
      { title: 'Stack de backend', reason: 'No se detectó código de backend.' },
    ]);
  });

  it('lists main (production) dependencies but not devDependencies', async () => {
    await writeFile(
      root,
      'package.json',
      JSON.stringify({
        dependencies: { react: '^18.0.0', axios: '^1.0.0' },
        devDependencies: { vitest: '^1.0.0', eslint: '^8.0.0' },
      }),
    );

    const index = makeEmptyIndex(root);
    bedrockClient.isAvailableMock.mockResolvedValue(true);
    bedrockClient.queryMock.mockResolvedValue('Flujo.');

    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root);
    const result = await explainer.explain();

    expect(result.mainDependencies.sort()).toEqual(['axios', 'react']);
  });

  it('produces an applicationFlow description via Bedrock on success', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ dependencies: {} }));
    const index = makeEmptyIndex(root);

    bedrockClient.isAvailableMock.mockResolvedValue(true);
    bedrockClient.queryMock.mockResolvedValue('El usuario hace clic y el sistema responde.');

    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root);
    const result = await explainer.explain();

    expect(result.applicationFlow).toBe('El usuario hace clic y el sistema responde.');
    expect(result.flowGenerationFailed).toBe(false);
    expect(bedrockClient.queryMock).toHaveBeenCalledTimes(1);
  });

  it('reports a clear failure message without throwing when Bedrock is unavailable', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ dependencies: {} }));
    const index = makeEmptyIndex(root);

    bedrockClient.isAvailableMock.mockResolvedValue(false);

    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root);
    const result = await explainer.explain();

    expect(result.applicationFlow).toBe(FLOW_UNAVAILABLE_MESSAGE);
    expect(result.flowGenerationFailed).toBe(true);
    expect(bedrockClient.queryMock).not.toHaveBeenCalled();
  });

  it('reports a clear failure message without throwing when the Bedrock query itself errors', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ dependencies: {} }));
    const index = makeEmptyIndex(root);

    bedrockClient.isAvailableMock.mockResolvedValue(true);
    bedrockClient.queryMock.mockRejectedValue(new Error('boom'));

    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root);
    const result = await explainer.explain();

    expect(result.applicationFlow).toBe(FLOW_UNAVAILABLE_MESSAGE);
    expect(result.flowGenerationFailed).toBe(true);
  });

  it('returns a partial explanation instead of throwing when the overall timeout is exceeded', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    const index = makeEmptyIndex(root);
    index.symbols.set('comp#App@1', makeComponentSymbol({ filePath: path.join(root, 'src/App.tsx') }));

    bedrockClient.isAvailableMock.mockResolvedValue(true);
    // Bedrock never resolves within the test's tiny injected timeout budget.
    bedrockClient.queryMock.mockImplementation(() => new Promise(() => {}));

    // Small injected timeout (5ms) for test speed, mirroring Searcher's tests.
    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root, 5);
    const result = await explainer.explain();

    expect(result.flowGenerationFailed).toBe(true);
    expect(result.applicationFlow).toBe(FLOW_UNAVAILABLE_MESSAGE);
    // Synchronous sections are still populated even though the timeout fired.
    expect(result.frontendStack).toEqual(['react']);
  });

  it('reexplain identifies changed sections when dependencies differ between two explanation snapshots', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0', axios: '^1.0.0' } }));
    const index = makeEmptyIndex(root);

    bedrockClient.isAvailableMock.mockResolvedValue(true);
    bedrockClient.queryMock.mockResolvedValue('Flujo actualizado.');

    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root);

    const previous: RepositoryExplanation = {
      frontendStack: ['react'],
      backendStack: undefined,
      mainDependencies: ['react'],
      applicationFlow: 'Flujo anterior.',
      omittedSections: [{ title: 'Stack de backend', reason: 'No se detectó código de backend.' }],
      flowGenerationFailed: false,
      generatedAt: new Date(),
    };

    const { explanation, changedSections } = await explainer.reexplain(previous);

    expect(explanation.mainDependencies.sort()).toEqual(['axios', 'react']);
    expect(changedSections).toEqual(
      expect.arrayContaining(['Principales dependencias', 'Flujo principal de la aplicación']),
    );
    expect(changedSections).not.toContain('Stack de frontend');
  });

  it('reexplain reports no changed sections when nothing differs', async () => {
    await writeFile(root, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    const index = makeEmptyIndex(root);

    bedrockClient.isAvailableMock.mockResolvedValue(true);
    bedrockClient.queryMock.mockResolvedValue('Mismo flujo.');

    const explainer = new RepositoryExplainer(new FakeIndexer(index), bedrockClient, root);
    const first = await explainer.explain();

    const { changedSections } = await explainer.reexplain(first);

    expect(changedSections).toEqual([]);
  });
});
