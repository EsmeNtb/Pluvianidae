/**
 * Extension entry point (`src/extension.ts`).
 *
 * Wires every previously-implemented module together into a working
 * `activate(context)` function: constructs the core singletons (Event Bus,
 * Security Filter, Bedrock Client, Indexador, Seed Engine, Mascota), builds
 * every analysis module on top of them, registers the 7 user-facing
 * commands, triggers full + incremental indexing, and connects analysis
 * findings to seed creation and the Mascota via the Event Bus. See
 * design.md's architecture overview and requirements.md > Requirement 1
 * (1.1, 1.5, 1.7).
 *
 * ## Notable wiring decisions (documented here rather than left implicit)
 *
 *   1. **MascotController ↔ AnimationEngine adapter.** `MascotController`
 *      expects an `IMascotRenderer` whose `playAnimation()` renders
 *      immediately; `AnimationEngine` implements a differently-shaped
 *      `IAnimationEngine.enqueue()` that queues/times animations before
 *      handing them to a real `IAnimationPlayer`. These two modules were
 *      built independently and don't share an interface, so a small
 *      adapter object is constructed here: it satisfies `IMascotRenderer`
 *      structurally, delegating `show`/`hide`/`positionNear` straight
 *      through to the real `MascotWebview`, but routing `playAnimation`
 *      through `animationEngine.enqueue(...)` instead of calling the
 *      webview directly. The resulting chain is:
 *      `MascotController.animate()` → adapter.playAnimation() →
 *      `AnimationEngine.enqueue()` → (after queue/timing processing) →
 *      `MascotWebview.playAnimation()` → actual rendering.
 *
 *   2. **`analysis:finding` → `seed:created` wiring.** No analysis module
 *      emits `analysis:finding` on its own — each command handler below
 *      explicitly converts its module's own report/finding shape
 *      (`DeadCodeFinding`, `FBComparisonReport`'s four categories,
 *      `PreCommitFinding`/`SecretFinding`) into the generic `Finding` shape
 *      and emits `analysis:finding` right after its analysis completes.
 *      A single Event Bus subscription registered once here listens for
 *      `analysis:finding`, turns every such event into a `Seed` via
 *      `seedEngine.createSeed(finding)`, and then emits `seed:created`
 *      with that seed — this second emission is required because nothing
 *      else in the codebase currently emits `seed:created`, and the
 *      Mascota's existing `wireMascotToEventBus` listens for exactly that
 *      event to react to new pending seeds (requirements.md 9.6).
 *
 *   3. **Configuration loading (expanded by task 16.3).** `PluvianidaeConfig`
 *      is loaded by overlaying `DEFAULT_CONFIG` with whatever the user has
 *      set under the `pluvianidae.*` VS Code settings. Task 16.1 originally
 *      wired only the three most operationally relevant fields
 *      (`bedrockRegion`, `bedrockModelId`, `enableMascot`) and deferred the
 *      rest as "nice-to-have". Task 16.3 ("Configure extension settings
 *      schema in `package.json`") completes this: `contributes.configuration`
 *      now declares all eight `PluvianidaeConfig` fields, and `loadConfig()`
 *      below reads every one of them via the same `settings.get(...)`
 *      pattern. Note that reading a setting into `PluvianidaeConfig` is as
 *      far as this task's scope goes — actually *acting* on
 *      `maxIndexingTime`/`maxPreCommitTime` would mean passing them into
 *      `IndexBuilder`/`PreCommitReviewer`'s constructors, which are
 *      existing, already-tested modules outside this task's "wiring only in
 *      extension.ts/package.json" scope, so those two modules keep using
 *      their own internal default timeouts for now.
 *
 *   4. **Indexing progress status bar (requirements.md 1.5).** A single
 *      `vscode.StatusBarItem` is created once in `activate()` and driven by
 *      three additional Event Bus subscriptions (`indexing:started`,
 *      `indexing:progress`, `indexing:completed`) — the same three events
 *      `IndexBuilder` already emits for full indexing and `IncrementalIndexer`
 *      reuses for incremental re-indexing (per its own doc comment), so this
 *      one status bar item covers both without any extra wiring. It shows
 *      "0/N" on `indexing:started`, "current/total (fileName)" on every
 *      `indexing:progress` tick, and a brief "✓ ... completa" message on
 *      `indexing:completed` before auto-hiding after a short delay.
 *
 *   5. **Diagnostic decorations for findings.** `analysis:finding` is
 *      already emitted by the `detectDeadCode`/`compareFrontendBackend`/
 *      `preCommitReview` command handlers (see decision #2 above). Each of
 *      those three handlers now *also* populates its own
 *      `vscode.DiagnosticCollection` (`pluvianidae-dead-code`,
 *      `pluvianidae-fb-comparator`, `pluvianidae-precommit`) — one
 *      collection per command rather than a single shared collection, so
 *      that running one analysis command doesn't clobber another command's
 *      still-relevant diagnostics. Each handler clears and fully repopulates
 *      *its own* collection at the start of its run (see
 *      `updateDiagnosticsForFindings`), so re-running the same command
 *      replaces rather than accumulates duplicate diagnostics. Severity is
 *      derived from `finding.confidence` (`'alto'` → Warning, `'medio'`/
 *      `'bajo'` → Information) except for pre-commit-derived findings, whose
 *      `description` is prefixed with `[error]`/`[advertencia]`/
 *      `[recomendación]` by `preCommitFindingToFinding` — that prefix is
 *      parsed back out (`parsePrecommitSeverityPrefix`) to get a more
 *      accurate Error/Warning/Information mapping for those findings
 *      instead of treating them uniformly. Findings with neither a
 *      confidence nor a recognized prefix (e.g. frontend-backend comparator
 *      findings, which carry neither) default to Information.
 */

import * as vscode from 'vscode';
import { DEFAULT_CONFIG, Finding, MascotAnimation, PluvianidaeConfig } from './core/models';
import { EventBus, IEventBus, PluvianidaeEvent } from './core/event-bus';
import { SecurityFilter } from './services/security-filter';
import { BedrockClient } from './services/bedrock-client';
import { IndexBuilder } from './modules/indexer/index-builder';
import { IncrementalIndexer } from './modules/indexer/incremental';
import { Searcher } from './modules/searcher/searcher';
import { ReferenceAnalyzer } from './modules/reference-analyzer/reference-analyzer';
import { DeadCodeDetector, DeadCodeFinding } from './modules/dead-code-detector/dead-code-detector';
import { FrontendBackendComparator, FBComparisonReport } from './modules/frontend-backend-comparator/comparator';
import { PreCommitReviewer, PreCommitFinding, SecretFinding } from './modules/pre-commit-reviewer/pre-commit-reviewer';
import { SecretDetector, SecretCommitGate } from './modules/pre-commit-reviewer/secret-detector';
import { ReadmeGenerator } from './modules/readme-generator/readme-generator';
import { computeReadmeDiff } from './modules/readme-generator/readme-diff';
import { RepositoryExplainer } from './modules/explainer/explainer';
import { SeedEngine } from './modules/seed-engine/seed-engine';
import { SeedStore } from './modules/seed-engine/seed-store';
import { AutoFixService } from './modules/dead-code-detector/fix-confirmation';
import { registerSeedBasketView } from './presentation/seed-basket-view';
import { IMascotRenderer, MascotController } from './presentation/mascot/mascot-controller';
import { AnimationEngine } from './presentation/mascot/animation-engine';
import { MascotWebview, wireMascotToEventBus } from './presentation/mascot/mascot-webview';

let outputChannel: vscode.OutputChannel | undefined;

/** How long the "✓ ... completa" message stays in the status bar before it hides itself (ms). */
const INDEXING_COMPLETE_MESSAGE_DURATION_MS = 4000;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  outputChannel = vscode.window.createOutputChannel('Pluvianidae');
  context.subscriptions.push(outputChannel);

  const config = loadConfig();

  // -----------------------------------------------------------------
  // Core singletons, in dependency order.
  // -----------------------------------------------------------------
  const eventBus: IEventBus = new EventBus();
  const securityFilter = new SecurityFilter();
  const bedrockClient = new BedrockClient(config);
  const indexBuilder = new IndexBuilder(undefined, undefined, eventBus);
  const incrementalIndexer = new IncrementalIndexer(indexBuilder, securityFilter, eventBus);

  const seedEngine = new SeedEngine();
  const seedStore = workspaceRoot ? new SeedStore(workspaceRoot, seedEngine) : undefined;
  void seedStore; // constructed for future persistence use; not yet triggered from any command (MVP scope).

  // Mascota: MascotWebview (real IMascotRenderer/IAnimationPlayer) wrapped
  // by AnimationEngine (queues/times animations), fronted by an adapter
  // that satisfies MascotController's IMascotRenderer shape — see this
  // file's top doc comment, decision #1.
  const mascotWebview = new MascotWebview();
  const animationEngine = new AnimationEngine(mascotWebview);
  const mascotRendererAdapter: IMascotRenderer = {
    show: () => mascotWebview.show(),
    hide: () => mascotWebview.hide(),
    positionNear: (filePath: string) => mascotWebview.positionNear(filePath),
    playAnimation: (animation: MascotAnimation) => animationEngine.enqueue(animation),
  };
  const mascotController = new MascotController(mascotRendererAdapter);
  // AnimationEngine.dispose() isn't reachable through any other Disposable
  // chain (MascotController never disposes its renderer), so it needs an
  // explicit wrapper pushed onto context.subscriptions.
  context.subscriptions.push({ dispose: () => animationEngine.dispose() });

  // -----------------------------------------------------------------
  // Analysis modules.
  // -----------------------------------------------------------------
  const searcher = new Searcher(indexBuilder, bedrockClient);
  const referenceAnalyzer = new ReferenceAnalyzer(indexBuilder);
  const deadCodeDetector = new DeadCodeDetector(indexBuilder);
  const autoFixService = new AutoFixService();
  const frontendBackendComparator = new FrontendBackendComparator(indexBuilder);
  const secretDetector = new SecretDetector();
  const secretCommitGate = new SecretCommitGate();
  const preCommitReviewer = workspaceRoot
    ? new PreCommitReviewer(workspaceRoot, undefined, undefined, secretDetector, indexBuilder, deadCodeDetector)
    : undefined;
  const readmeGenerator = workspaceRoot
    ? new ReadmeGenerator(indexBuilder, bedrockClient, workspaceRoot, undefined, undefined, computeReadmeDiff)
    : undefined;
  const repositoryExplainer = workspaceRoot
    ? new RepositoryExplainer(indexBuilder, bedrockClient, workspaceRoot)
    : undefined;

  // -----------------------------------------------------------------
  // Seed basket view (requirements.md 9.5, 9.7).
  // -----------------------------------------------------------------
  const seedBasketView = registerSeedBasketView(seedEngine, eventBus);
  context.subscriptions.push({ dispose: () => seedBasketView.dispose() });

  // -----------------------------------------------------------------
  // Diagnostic decorations for findings — one DiagnosticCollection per
  // analysis command (see this file's top doc comment, decision #5), so
  // that running one command's analysis doesn't clear another command's
  // still-relevant diagnostics.
  // -----------------------------------------------------------------
  const deadCodeDiagnostics = vscode.languages.createDiagnosticCollection('pluvianidae-dead-code');
  const fbComparatorDiagnostics = vscode.languages.createDiagnosticCollection('pluvianidae-fb-comparator');
  const precommitDiagnostics = vscode.languages.createDiagnosticCollection('pluvianidae-precommit');
  context.subscriptions.push(deadCodeDiagnostics, fbComparatorDiagnostics, precommitDiagnostics);

  // -----------------------------------------------------------------
  // Trigger full indexing on workspace open (requirements.md 1.1, 1.5) —
  // fire-and-forget: indexing can take a while and activate() must not
  // block on it. indexing:started/progress/completed are emitted by
  // IndexBuilder itself.
  // -----------------------------------------------------------------
  if (workspaceRoot) {
    indexBuilder.indexRepository(workspaceRoot).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[Pluvianidae] Error during initial indexing: ${describeError(err)}`);
    });
  }

  // Incremental indexing (requirements.md 1.7).
  context.subscriptions.push(incrementalIndexer.watch());

  // -----------------------------------------------------------------
  // Indexing progress status bar (requirements.md 1.5) — see this file's
  // top doc comment, decision #4. Covers both full and incremental
  // indexing, since both funnel through the same three event types.
  // -----------------------------------------------------------------
  const indexingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  context.subscriptions.push(indexingStatusBarItem);
  let indexingCompleteTimeout: NodeJS.Timeout | undefined;

  context.subscriptions.push(
    eventBus.on('indexing:started', (event) => {
      if (event.type !== 'indexing:started') {
        return;
      }
      clearTimeout(indexingCompleteTimeout);
      indexingStatusBarItem.text = formatIndexingStartedText(event.payload.totalFiles);
      indexingStatusBarItem.show();
    }),
  );

  context.subscriptions.push(
    eventBus.on('indexing:progress', (event) => {
      if (event.type !== 'indexing:progress') {
        return;
      }
      indexingStatusBarItem.text = formatIndexingProgressText(
        event.payload.current,
        event.payload.total,
        event.payload.currentFile,
      );
      indexingStatusBarItem.show();
    }),
  );

  context.subscriptions.push(
    eventBus.on('indexing:completed', (event) => {
      if (event.type !== 'indexing:completed') {
        return;
      }
      indexingStatusBarItem.text = formatIndexingCompletedText(event.payload.filesIndexed);
      indexingStatusBarItem.show();
      clearTimeout(indexingCompleteTimeout);
      indexingCompleteTimeout = setTimeout(() => {
        indexingStatusBarItem.hide();
      }, INDEXING_COMPLETE_MESSAGE_DURATION_MS);
    }),
  );

  // Mascota ↔ Event Bus wiring (requirements.md 9.6, 10.2, 10.5).
  context.subscriptions.push(wireMascotToEventBus(eventBus, mascotController, seedEngine));
  if (config.enableMascot) {
    mascotController.show();
  }

  // analysis:finding → seed creation → seed:created (see this file's top
  // doc comment, decision #2).
  context.subscriptions.push(
    eventBus.on('analysis:finding', (event: PluvianidaeEvent) => {
      if (event.type !== 'analysis:finding') {
        return;
      }
      const seed = seedEngine.createSeed(event.payload);
      eventBus.emit({ type: 'seed:created', payload: seed });
    }),
  );

  // Keep the seed basket TreeView's list and pending count live as seeds
  // are created/change state (requirements.md 9.5) — see
  // seed-basket-view.ts's "Refresh contract" doc comment, which assigns
  // this exact wiring to extension activation.
  context.subscriptions.push(
    eventBus.on('seed:created', () => seedBasketView.provider.refresh()),
    eventBus.on('seed:updated', () => seedBasketView.provider.refresh()),
  );

  // -----------------------------------------------------------------
  // Commands.
  // -----------------------------------------------------------------
  const commands = [
    vscode.commands.registerCommand('pluvianidae.search', async () => {
      if (!workspaceRoot) {
        showNoWorkspaceMessage('buscar en el repositorio');
        return;
      }
      try {
        const query = await vscode.window.showInputBox({
          prompt: 'Buscar en el repositorio (lenguaje natural o texto exacto)',
        });
        if (!query) {
          return;
        }

        const results = await searcher.search(query);
        if (results.length === 0) {
          const suggestions = searcher.getSuggestions(query);
          vscode.window.showInformationMessage(
            `Pluvianidae: no se encontraron resultados para "${query}". Sugerencias: ${suggestions.join(', ')}`,
          );
          return;
        }

        const picked = await vscode.window.showQuickPick(
          results.map((result) => ({
            label: result.symbolName,
            description: result.filePath,
            detail: result.explanation,
            result,
          })),
          { placeHolder: `${results.length} resultado(s) encontrados para "${query}"` },
        );

        if (picked) {
          const doc = await vscode.workspace.openTextDocument(picked.result.fullPath);
          await vscode.window.showTextDocument(doc);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Pluvianidae: error al buscar - ${describeError(err)}`);
      }
    }),

    vscode.commands.registerCommand('pluvianidae.analyzeReferences', async () => {
      if (!workspaceRoot) {
        showNoWorkspaceMessage('analizar referencias');
        return;
      }
      try {
        let symbolName = getSelectedWordFromActiveEditor();
        if (!symbolName) {
          symbolName = await vscode.window.showInputBox({ prompt: 'Nombre del símbolo a analizar' });
        }
        if (!symbolName) {
          return;
        }

        const referenceMap = await referenceAnalyzer.getReferences({ name: symbolName });
        const summary =
          `Definición: ${referenceMap.definition.filePath}:${referenceMap.definition.line}\n` +
          `Imports: ${referenceMap.imports.length}, Usos: ${referenceMap.usages.length}, ` +
          `Llamadas: ${referenceMap.calls.length}, Dependientes: ${referenceMap.dependents.length}`;
        vscode.window.showInformationMessage(`Pluvianidae: referencias de "${symbolName}"\n${summary}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Pluvianidae: error al analizar referencias - ${describeError(err)}`);
      }
    }),

    vscode.commands.registerCommand('pluvianidae.detectDeadCode', async () => {
      if (!workspaceRoot) {
        showNoWorkspaceMessage('detectar código no utilizado');
        return;
      }
      try {
        const report = await deadCodeDetector.analyze();
        const findings: Finding[] = [];
        for (const finding of report.findings) {
          const converted = deadCodeFindingToFinding(finding);
          findings.push(converted);
          eventBus.emit({ type: 'analysis:finding', payload: converted });
        }
        updateDiagnosticsForFindings(deadCodeDiagnostics, findings);
        vscode.window.showInformationMessage(
          `Pluvianidae: se encontraron ${report.findings.length} hallazgo(s) de código no utilizado ` +
            `y ${report.warnings.length} advertencia(s) de código comentado/duplicado.`,
        );

        await offerToReviewAndApplyFixes(report.findings, autoFixService);
      } catch (err) {
        vscode.window.showErrorMessage(`Pluvianidae: error al detectar código no utilizado - ${describeError(err)}`);
      }
    }),

    vscode.commands.registerCommand('pluvianidae.compareFrontendBackend', async () => {
      if (!workspaceRoot) {
        showNoWorkspaceMessage('comparar frontend y backend');
        return;
      }
      try {
        const report = await frontendBackendComparator.analyze();
        const findings = comparisonReportToFindings(report);
        for (const finding of findings) {
          eventBus.emit({ type: 'analysis:finding', payload: finding });
        }
        updateDiagnosticsForFindings(fbComparatorDiagnostics, findings);
        vscode.window.showInformationMessage(
          `Pluvianidae: ${report.unconsumedEndpoints.length} endpoint(s) sin consumir, ` +
            `${report.missingEndpoints.length} llamada(s) sin endpoint, ` +
            `${report.typeIncompatibilities.length} incompatibilidad(es) de tipos, ` +
            `${report.discrepancies.length} discrepancia(s).`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Pluvianidae: error al comparar frontend-backend - ${describeError(err)}`);
      }
    }),

    vscode.commands.registerCommand('pluvianidae.preCommitReview', async () => {
      if (!workspaceRoot || !preCommitReviewer) {
        showNoWorkspaceMessage('ejecutar la revisión pre-commit');
        return;
      }
      try {
        const report = await preCommitReviewer.review();

        let proceed = true;
        if (report.secretsDetected.length > 0) {
          const gateResult = await secretCommitGate.evaluate(report.secretsDetected);
          proceed = gateResult.proceed;
        }

        const precommitFindings: Finding[] = [];
        for (const finding of report.findings) {
          const converted = preCommitFindingToFinding(finding);
          precommitFindings.push(converted);
          eventBus.emit({ type: 'analysis:finding', payload: converted });
        }
        for (const secret of report.secretsDetected) {
          const converted = secretFindingToFinding(secret);
          precommitFindings.push(converted);
          eventBus.emit({ type: 'analysis:finding', payload: converted });
        }
        updateDiagnosticsForFindings(precommitDiagnostics, precommitFindings);

        const hasErrors = report.findings.some((f) => f.severity === 'error') || report.secretsDetected.length > 0;
        eventBus.emit({ type: 'precommit:completed', payload: { hasErrors } });

        const secretsNote =
          report.secretsDetected.length > 0
            ? ` Se detectaron ${report.secretsDetected.length} posible(s) secreto(s); ` +
              `${proceed ? 'el usuario decidió continuar.' : 'el commit fue cancelado.'}`
            : '';
        vscode.window.showInformationMessage(
          `Pluvianidae: revisión pre-commit completada con ${report.findings.length} hallazgo(s).${secretsNote}`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Pluvianidae: error en la revisión pre-commit - ${describeError(err)}`);
      }
    }),

    vscode.commands.registerCommand('pluvianidae.generateReadme', async () => {
      if (!workspaceRoot || !readmeGenerator) {
        showNoWorkspaceMessage('generar el README');
        return;
      }
      try {
        const draft = await readmeGenerator.generateDraft();
        await readmeGenerator.applyDraft(draft);
      } catch (err) {
        vscode.window.showErrorMessage(`Pluvianidae: error al generar el README - ${describeError(err)}`);
      }
    }),

    vscode.commands.registerCommand('pluvianidae.explainRepository', async () => {
      if (!workspaceRoot || !repositoryExplainer) {
        showNoWorkspaceMessage('explicar el repositorio');
        return;
      }
      try {
        const explanation = await repositoryExplainer.explain();
        const channel = outputChannel!;
        channel.clear();
        channel.appendLine('=== Explicación del repositorio (Pluvianidae) ===');
        if (explanation.frontendStack) {
          channel.appendLine(`Stack de frontend: ${explanation.frontendStack.join(', ')}`);
        }
        if (explanation.backendStack) {
          channel.appendLine(`Stack de backend: ${explanation.backendStack.join(', ')}`);
        }
        channel.appendLine(`Dependencias principales: ${explanation.mainDependencies.join(', ') || '(ninguna)'}`);
        channel.appendLine('');
        channel.appendLine('Flujo principal de la aplicación:');
        channel.appendLine(explanation.applicationFlow);
        channel.show(true);
      } catch (err) {
        vscode.window.showErrorMessage(`Pluvianidae: error al explicar el repositorio - ${describeError(err)}`);
      }
    }),
  ];

  commands.forEach((cmd) => context.subscriptions.push(cmd));
}

export function deactivate(): void {
  // VS Code automatically disposes everything pushed to
  // context.subscriptions (commands, watchers, Event Bus subscriptions,
  // the seed basket view, and the AnimationEngine's explicit dispose
  // wrapper), so no additional cleanup is required here.
}

// ---------------------------------------------------------------------------
// Configuration loading
// ---------------------------------------------------------------------------

function loadConfig(): PluvianidaeConfig {
  const settings = vscode.workspace.getConfiguration('pluvianidae');
  return {
    ...DEFAULT_CONFIG,
    excludePatterns: settings.get<string[]>('excludePatterns', DEFAULT_CONFIG.excludePatterns),
    bedrockRegion: settings.get<string>('bedrockRegion', DEFAULT_CONFIG.bedrockRegion),
    bedrockModelId: settings.get<string>('bedrockModelId', DEFAULT_CONFIG.bedrockModelId),
    enableMascot: settings.get<boolean>('enableMascot', DEFAULT_CONFIG.enableMascot),
    confirmBeforeTransmit: settings.get<boolean>('confirmBeforeTransmit', DEFAULT_CONFIG.confirmBeforeTransmit),
    persistIndex: settings.get<boolean>('persistIndex', DEFAULT_CONFIG.persistIndex),
    maxIndexingTime: settings.get<number>('maxIndexingTime', DEFAULT_CONFIG.maxIndexingTime),
    maxPreCommitTime: settings.get<number>('maxPreCommitTime', DEFAULT_CONFIG.maxPreCommitTime),
  };
}

// ---------------------------------------------------------------------------
// Indexing progress status bar text (requirements.md 1.5) — pure formatting
// helpers, kept separate from the vscode.StatusBarItem plumbing in
// activate() so the exact wording is easy to read/adjust in one place.
// ---------------------------------------------------------------------------

function formatIndexingStartedText(totalFiles: number): string {
  return `Pluvianidae: indexando 0/${totalFiles}...`;
}

function formatIndexingProgressText(current: number, total: number, currentFile: string): string {
  return `Pluvianidae: indexando ${current}/${total} (${currentFile})`;
}

function formatIndexingCompletedText(filesIndexed: number): string {
  return `✓ Pluvianidae: indexación completa (${filesIndexed} archivo(s))`;
}

// ---------------------------------------------------------------------------
// Finding conversion helpers (see this file's top doc comment, decision #2)
// ---------------------------------------------------------------------------

/**
 * A `DeadCodeFinding` is "fixable" when `AutoFixService.proposeFix` would
 * actually offer a fix for it — i.e. its `suggestedAction` is `'eliminar'`
 * or `'comentar'`, not `'revisar-manualmente'` (see fix-confirmation.ts's
 * top doc comment).
 */
function isFixableFinding(finding: DeadCodeFinding): boolean {
  return finding.suggestedAction !== 'revisar-manualmente';
}

/**
 * After a `pluvianidae.detectDeadCode` run, offers the user a low-friction
 * way to review and apply the auto-fixes `AutoFixService` already knows
 * how to build (requirements.md 4.4, 11.6). Each fixable finding is driven
 * through the existing per-fix `proposeFix` → `applyFix` flow sequentially
 * — `applyFix` shows its own confirmation dialog per fix, so no separate
 * batch UI is built here. Does nothing when there are no fixable findings.
 */
async function offerToReviewAndApplyFixes(
  findings: DeadCodeFinding[],
  autoFixService: AutoFixService,
): Promise<void> {
  const fixableFindings = findings.filter(isFixableFinding);
  if (fixableFindings.length === 0) {
    return;
  }

  const REVIEW = 'Revisar correcciones';
  const selection = await vscode.window.showInformationMessage(
    `Pluvianidae: ${fixableFindings.length} hallazgo(s) tienen una corrección automática disponible.`,
    REVIEW,
  );
  if (selection !== REVIEW) {
    return;
  }

  let appliedCount = 0;
  for (const finding of fixableFindings) {
    const proposedFix = await autoFixService.proposeFix(finding);
    if (!proposedFix) {
      continue;
    }
    const result = await autoFixService.applyFix(proposedFix);
    if (result.outcome === 'applied') {
      appliedCount += 1;
    }
  }

  vscode.window.showInformationMessage(
    `Pluvianidae: se aplicaron ${appliedCount} de ${fixableFindings.length} correcciones propuestas.`,
  );
}

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
      description: `El frontend llama a ${call.method} ${call.url}, pero no existe un endpoint backend correspondiente.`,
    });
  }

  for (const incompatibility of report.typeIncompatibilities) {
    findings.push({
      type: 'fb-comparator:type-incompatibility',
      sourceModule: 'frontend-backend-comparator',
      filePath: incompatibility.frontendLocation.filePath,
      line: incompatibility.frontendLocation.line,
      description:
        `Incompatibilidad de tipos en ${incompatibility.endpoint}: backend espera ` +
        `${incompatibility.backendExpected}, frontend envía ${incompatibility.frontendSends}.`,
    });
  }

  for (const discrepancy of report.discrepancies) {
    findings.push({
      type: `fb-comparator:${discrepancy.category}`,
      sourceModule: 'frontend-backend-comparator',
      filePath: discrepancy.sourceFile,
      line: discrepancy.sourceLine,
      description: discrepancy.description,
    });
  }

  return findings;
}

function preCommitFindingToFinding(finding: PreCommitFinding): Finding {
  return {
    type: `precommit:${finding.checkType}`,
    sourceModule: 'pre-commit-reviewer',
    filePath: finding.filePath,
    line: finding.line,
    description: `[${finding.severity}] ${finding.description}`,
  };
}

function secretFindingToFinding(secret: SecretFinding): Finding {
  return {
    type: 'precommit:secret',
    sourceModule: 'pre-commit-reviewer',
    filePath: secret.filePath,
    line: secret.line,
    description: `Posible secreto detectado (${secret.pattern}).`,
  };
}

// ---------------------------------------------------------------------------
// Diagnostic decorations for findings (see this file's top doc comment,
// decision #5)
// ---------------------------------------------------------------------------

/**
 * `preCommitFindingToFinding` embeds the originating `PreCommitSeverity`
 * (`'error' | 'advertencia' | 'recomendación'`) as a `[severity]` prefix on
 * `Finding.description`. Parsing it back out here lets pre-commit-derived
 * findings get a more accurate `DiagnosticSeverity` than the generic
 * confidence-based mapping (which doesn't apply to them, since
 * `preCommitFindingToFinding` never sets `confidence`). Returns `undefined`
 * when the description has no recognized prefix (e.g. secret findings,
 * which use a different, unprefixed description).
 */
function parsePrecommitSeverityPrefix(description: string): 'error' | 'advertencia' | 'recomendación' | undefined {
  const match = /^\[(error|advertencia|recomendación)\]/.exec(description);
  return match ? (match[1] as 'error' | 'advertencia' | 'recomendación') : undefined;
}

/**
 * Maps a generic `Finding` to a `vscode.DiagnosticSeverity`. Pre-commit
 * findings (identified by their `[severity]` description prefix) use that
 * prefix directly for a precise Error/Warning/Information mapping; all
 * other findings fall back to `finding.confidence` ("alto" → Warning,
 * "medio"/"bajo" → Information), and findings with neither signal (e.g.
 * frontend-backend comparator findings, secret findings) default to
 * Information.
 */
function mapFindingToDiagnosticSeverity(finding: Finding): vscode.DiagnosticSeverity {
  const precommitSeverity = parsePrecommitSeverityPrefix(finding.description);
  if (precommitSeverity === 'error') {
    return vscode.DiagnosticSeverity.Error;
  }
  if (precommitSeverity === 'advertencia') {
    return vscode.DiagnosticSeverity.Warning;
  }
  if (precommitSeverity === 'recomendación') {
    return vscode.DiagnosticSeverity.Information;
  }

  if (finding.confidence === 'alto') {
    return vscode.DiagnosticSeverity.Warning;
  }

  return vscode.DiagnosticSeverity.Information;
}

/**
 * Builds the `vscode.Range` for a finding's diagnostic: the full line
 * `finding.line` (1-based, per `Finding.line`'s convention) when present,
 * falling back to the first line of the file when the finding carries no
 * line number.
 */
function mapFindingLineToRange(line: number | undefined): vscode.Range {
  const zeroBasedLine = Math.max(0, (line ?? 1) - 1);
  return new vscode.Range(zeroBasedLine, 0, zeroBasedLine, Number.MAX_SAFE_INTEGER);
}

/**
 * Clears and repopulates `collection` with `findings`, grouped by file
 * (`DiagnosticCollection.set(uri, diagnostics[])` is called once per file,
 * not once per finding, so diagnostics accumulate correctly within a file
 * instead of overwriting each other). Findings without a `filePath` are
 * skipped, since `vscode.Diagnostic`s must be attached to a file `Uri`.
 * Called at the start of each analysis command's handler so re-running the
 * same command replaces its own prior diagnostics rather than accumulating
 * duplicates.
 */
function updateDiagnosticsForFindings(collection: vscode.DiagnosticCollection, findings: Finding[]): void {
  collection.clear();

  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const finding of findings) {
    if (!finding.filePath) {
      continue;
    }
    const diagnostic = new vscode.Diagnostic(
      mapFindingLineToRange(finding.line),
      finding.description,
      mapFindingToDiagnosticSeverity(finding),
    );
    diagnostic.source = 'Pluvianidae';
    const existing = byFile.get(finding.filePath);
    if (existing) {
      existing.push(diagnostic);
    } else {
      byFile.set(finding.filePath, [diagnostic]);
    }
  }

  for (const [filePath, diagnostics] of byFile) {
    collection.set(vscode.Uri.file(filePath), diagnostics);
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function showNoWorkspaceMessage(action: string): void {
  vscode.window.showInformationMessage(`Pluvianidae: abre una carpeta de proyecto para ${action}.`);
}

function getSelectedWordFromActiveEditor(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
  if (!wordRange) {
    return undefined;
  }
  return editor.document.getText(wordRange);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
