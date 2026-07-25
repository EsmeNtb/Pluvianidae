/**
 * Integration tests for the full Pluvianidae workflow (task 16.4).
 *
 * These tests exercise real (non-stubbed) implementations of the core
 * pipeline modules — `IndexBuilder`, `DeadCodeDetector`,
 * `FrontendBackendComparator`, `SeedEngine`, and a real `EventBus`
 * instance — wired together the same way `src/extension.ts` wires them in
 * `activate()` (see that file's top doc comment, decision #2): each
 * analysis module's own finding shape is converted into a generic
 * `Finding`, emitted as `analysis:finding` on the Event Bus, and a single
 * subscriber turns every such event into a `Seed` via
 * `SeedEngine.createSeed(...)` and re-emits `seed:created`.
 *
 * Only VS Code API surfaces (webviews, status bar, commands) are excluded
 * here, since those can't run outside an extension host — everything else
 * uses real module implementations against a real temp-directory repo on
 * disk (no mocks/stubs for the modules under test).
 *
 * **Validates: Requirements All (end-to-end validation)**
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { IndexBuilder } from '../../src/modules/indexer/index-builder';
import { DeadCodeDetector, DeadCodeFinding } from '../../src/modules/dead-code-detector/dead-code-detector';
import { FrontendBackendComparator, FBComparisonReport } from '../../src/modules/frontend-backend-comparator/comparator';
import { SeedEngine } from '../../src/modules/seed-engine/seed-engine';
import { EventBus, PluvianidaeEvent } from '../../src/core/event-bus';
import { Finding, Seed } from '../../src/core/models';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-integration-'));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/**
 * Mirrors `deadCodeFindingToFinding` from `src/extension.ts` — kept local
 * to this test file rather than imported, since that helper is not
 * exported from `extension.ts` (it wires VS Code activation, which this
 * test intentionally avoids importing).
 */
function deadCodeFindingToFinding(finding: DeadCodeFinding): Finding {
  return {
    type: `dead-code:${finding.type}`,
    sourceModule: 'dead-code-detector',
    filePath: finding.filePath,
    line: finding.line,
    description: finding.description,
    suggestedAction: finding.suggestedAction,
    confidence: finding.confidence,
  };
}

/** Mirrors `comparisonReportToFindings` from `src/extension.ts` (missing-endpoints subset used by these tests). */
function comparisonReportToFindings(report: FBComparisonReport): Finding[] {
  const findings: Finding[] = [];
  for (const endpoint of report.unconsumedEndpoints) {
    findings.push({
      type: 'fb-comparator:unconsumed-endpoint',
      sourceModule: 'frontend-backend-comparator',
      filePath: endpoint.definitionFile,
      line: endpoint.definitionLine,
      description: `El endpoint ${endpoint.method} ${endpoint.route} no es consumido por ningún llamado del frontend.`,
    });
  }
  for (const call of report.missingEndpoints) {
    findings.push({
      type: 'fb-comparator:missing-endpoint',
      sourceModule: 'frontend-backend-comparator',
      filePath: call.callFile,
      line: call.callLine,
      description: `La llamada ${call.method} ${call.url} no coincide con ningún endpoint del backend.`,
    });
  }
  return findings;
}

/**
 * Sets up a small synthetic repo on disk: a backend route file, a frontend
 * fetch-call file (one endpoint consumed, one call with no matching
 * endpoint), a file with an unused import (dead code), and a package.json.
 */
async function createSyntheticRepo(root: string): Promise<void> {
  await writeFile(root, 'package.json', JSON.stringify({ name: 'synthetic-repo', version: '1.0.0' }, null, 2));

  await writeFile(
    root,
    'src/backend/routes.ts',
    [
      "app.get('/users', (req, res) => {",
      '  res.send([]);',
      '});',
      '',
    ].join('\n'),
  );

  await writeFile(
    root,
    'src/frontend/api.ts',
    [
      'async function loadUsers() {',
      "  return fetch('/users');",
      '}',
      '',
      'async function loadOrders() {',
      "  return fetch('/orders');",
      '}',
      '',
    ].join('\n'),
  );

  await writeFile(
    root,
    'src/utils/math.ts',
    [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export function subtract(a: number, b: number): number {',
      '  return a - b;',
      '}',
      '',
    ].join('\n'),
  );

  await writeFile(
    root,
    'src/utils/consumer.ts',
    [
      // 'subtract' is imported but never used -> unused-import finding.
      "import { add, subtract } from './math';",
      '',
      'console.log(add(1, 2));',
      '',
    ].join('\n'),
  );
}

describe('Full workflow integration', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
    await createSyntheticRepo(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('indexes a real synthetic repo end-to-end, producing the expected files/symbols/endpoints', async () => {
    const eventBus = new EventBus();
    const indexBuilder = new IndexBuilder(undefined, undefined, eventBus);

    const result = await indexBuilder.indexRepository(root);

    expect(result.totalFiles).toBe(4);
    expect(result.filesProcessed).toBe(4);
    expect(result.errors).toEqual([]);

    const index = indexBuilder.getIndex();
    expect(index.rootPath).toBe(root);
    expect(index.files.size).toBe(4);

    const symbolNames = Array.from(index.symbols.values()).map((s) => s.name);
    expect(symbolNames).toContain('add');
    expect(symbolNames).toContain('subtract');

    expect(index.endpoints).toHaveLength(1);
    expect(index.endpoints[0]).toMatchObject({ route: '/users', method: 'GET' });
  });

  it('runs DeadCodeDetector and FrontendBackendComparator against the real index and produces the expected findings', async () => {
    const indexBuilder = new IndexBuilder();
    await indexBuilder.indexRepository(root);

    const deadCodeDetector = new DeadCodeDetector(indexBuilder);
    const deadCodeReport = await deadCodeDetector.analyze();

    const consumerPath = path.join(root, 'src', 'utils', 'consumer.ts');
    const unusedImportFindings = deadCodeReport.findings.filter(
      (f) => f.type === 'unused-import' && f.filePath === consumerPath,
    );
    expect(unusedImportFindings).toHaveLength(1);
    expect(unusedImportFindings[0].description).toContain('subtract');

    const comparator = new FrontendBackendComparator(indexBuilder);
    const comparisonReport = await comparator.analyze();

    // '/users' is consumed by loadUsers(), so it must not appear as unconsumed.
    expect(comparisonReport.unconsumedEndpoints.some((e) => e.route === '/users')).toBe(false);

    // '/orders' has no matching backend endpoint -> missing-endpoint finding.
    expect(comparisonReport.missingEndpoints).toHaveLength(1);
    expect(comparisonReport.missingEndpoints[0]).toMatchObject({ url: '/orders', method: 'GET' });
  });

  it('converts findings into Seeds via SeedEngine.createSeed, which then appear in getPendingSeeds()', async () => {
    const indexBuilder = new IndexBuilder();
    await indexBuilder.indexRepository(root);

    const deadCodeDetector = new DeadCodeDetector(indexBuilder);
    const deadCodeReport = await deadCodeDetector.analyze();

    const comparator = new FrontendBackendComparator(indexBuilder);
    const comparisonReport = await comparator.analyze();

    const findings: Finding[] = [
      ...deadCodeReport.findings.map(deadCodeFindingToFinding),
      ...comparisonReportToFindings(comparisonReport),
    ];
    expect(findings.length).toBeGreaterThan(0);

    const seedEngine = new SeedEngine();
    const createdSeeds: Seed[] = findings.map((finding) => seedEngine.createSeed(finding));

    const pendingSeeds = seedEngine.getPendingSeeds();
    expect(pendingSeeds).toHaveLength(createdSeeds.length);
    expect(pendingSeeds.every((seed) => seed.state === 'Pendiente')).toBe(true);

    // The unused-import finding should classify as 'problema' (has a confidence level).
    const unusedImportSeed = pendingSeeds.find((s) => s.description.includes('subtract'));
    expect(unusedImportSeed).toBeDefined();
    expect(unusedImportSeed?.type).toBe('problema');

    // The missing-endpoint finding has no confidence -> classifies as 'recomendación'.
    const missingEndpointSeed = pendingSeeds.find((s) => s.description.includes('/orders'));
    expect(missingEndpointSeed).toBeDefined();
    expect(missingEndpointSeed?.type).toBe('recomendación');
  });

  it('fires Event Bus events in the expected order across the full indexing -> analysis -> seed-creation pipeline', async () => {
    const eventBus = new EventBus();
    const received: PluvianidaeEvent[] = [];

    eventBus.on('indexing:started', (e) => received.push(e));
    eventBus.on('indexing:progress', (e) => received.push(e));
    eventBus.on('indexing:completed', (e) => received.push(e));
    eventBus.on('analysis:finding', (e) => received.push(e));
    eventBus.on('seed:created', (e) => received.push(e));

    const seedEngine = new SeedEngine();
    // Same wiring extension.ts uses: analysis:finding -> createSeed -> seed:created.
    eventBus.on('analysis:finding', (event) => {
      if (event.type !== 'analysis:finding') {
        return;
      }
      const seed = seedEngine.createSeed(event.payload);
      eventBus.emit({ type: 'seed:created', payload: seed });
    });

    const indexBuilder = new IndexBuilder(undefined, undefined, eventBus);
    await indexBuilder.indexRepository(root);

    const deadCodeDetector = new DeadCodeDetector(indexBuilder);
    const deadCodeReport = await deadCodeDetector.analyze();
    for (const finding of deadCodeReport.findings) {
      eventBus.emit({ type: 'analysis:finding', payload: deadCodeFindingToFinding(finding) });
    }

    // Verify overall ordering: indexing lifecycle events come first, in
    // order, followed by analysis:finding/seed:created pairs (each
    // analysis:finding is immediately followed by its seed:created,
    // since the Event Bus dispatches synchronously in emission order).
    expect(received[0].type).toBe('indexing:started');

    const firstAnalysisIndex = received.findIndex((e) => e.type === 'analysis:finding');
    expect(firstAnalysisIndex).toBeGreaterThan(0);

    const indexingEvents = received.slice(0, firstAnalysisIndex);
    expect(indexingEvents.every((e) => e.type.startsWith('indexing:'))).toBe(true);
    expect(indexingEvents[indexingEvents.length - 1].type).toBe('indexing:completed');

    const analysisAndSeedEvents = received.slice(firstAnalysisIndex);
    expect(analysisAndSeedEvents.length).toBeGreaterThan(0);
    expect(analysisAndSeedEvents.length % 2).toBe(0);
    for (let i = 0; i < analysisAndSeedEvents.length; i += 2) {
      expect(analysisAndSeedEvents[i].type).toBe('analysis:finding');
      expect(analysisAndSeedEvents[i + 1].type).toBe('seed:created');
    }

    // Seeds created via the event pipeline are also visible through the
    // SeedEngine's own query API, confirming the two are the same instance.
    expect(seedEngine.getPendingSeeds().length).toBe(deadCodeReport.findings.length);
  });
});
