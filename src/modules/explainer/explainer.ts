/**
 * Explicador de Repositorio (Repository Explainer) module.
 *
 * Produces a repository explanation for a developer entering an unfamiliar
 * codebase: detected frontend stack, detected backend stack, main
 * (production) dependencies, and a Bedrock-generated natural-language
 * description of the application's main flow. See design.md > "Explicador
 * de Repositorio" (architecture diagram `EXPL` node, Bedrock integration,
 * 15s time budget table) and requirements.md > Requirement 8 (8.1-8.5).
 *
 * ## Design decisions for ambiguities not pinned down by design.md
 *
 * design.md's component-interface sections (numbered 1-12) do not include
 * a dedicated block for the Explicador — it only appears in the
 * architecture diagram and the error-handling/testing tables. The
 * interface below (`IRepositoryExplainer`, `RepositoryExplanation`) is
 * therefore designed here, following the same conventions as the other
 * modules' documented interfaces (`ISearcher`/`SearchResult`,
 * `IReadmeGenerator`/`ReadmeDraft`):
 *
 *   1. **`RepositoryExplanation` shape** — mirrors `ReadmeDraft`'s
 *      `omittedSections: OmittedSection[]` pattern (design.md > "9.
 *      Generador de README") for reporting which sections were skipped and
 *      why (8.4), rather than inventing a new shape.
 *
 *   2. **Retry mechanism for Bedrock failures (8.5)** — there is no
 *      separate persisted "failed" state to resume from; the interface has
 *      no cancellation/retry token. The simplest faithful implementation:
 *      `explain()` always returns a complete `RepositoryExplanation`
 *      (never throws for a Bedrock failure), with `flowGenerationFailed:
 *      true` and an explanatory `applicationFlow` placeholder message when
 *      the flow description couldn't be generated. "Retrying" is simply
 *      calling `explain()` again — the caller (UI layer) is expected to
 *      offer a "Reintentar" action that re-invokes `explain()`.
 *
 *   3. **15s overall budget (8.1) vs BedrockClient's own 10s timeout
 *      (8.5, task 5.1)** — stack/dependency detection is synchronous and
 *      effectively instantaneous, so in practice nearly the entire 15s
 *      budget is available for the Bedrock call. Rather than reconciling
 *      two independent timeouts (which could race and produce a confusing
 *      double-timeout), `explain()` races the *whole* explanation-building
 *      flow (stack detection + Bedrock flow-description call) against its
 *      own `explainTimeoutMs` (default 15s, per requirement 8.1). If that
 *      elapses first, the already-computed synchronous sections (stacks,
 *      dependencies) are returned immediately with `applicationFlow` set
 *      to a timeout placeholder and `flowGenerationFailed: true` — the
 *      user still gets a useful partial explanation rather than nothing,
 *      consistent with the Searcher's `withTimeout` fallback pattern and
 *      design.md's error table ("Informar al usuario. Ofrecer reintento.").
 *      Internally, `BedrockClient.query()` already enforces its own 10s
 *      timeout independently (task 5.1) — that's simply a tighter bound
 *      nested inside the Explainer's 15s outer budget, so whichever fires
 *      first determines the failure reported to the user; both are
 *      surfaced identically via `flowGenerationFailed`.
 *
 *   4. **Re-explanation (8.3)** — `reexplain(previous)` regenerates the
 *      explanation via the same `buildExplanation` logic used by
 *      `explain()`, then diffs the result against `previous`: array
 *      equality (order-independent, per-element) for `frontendStack` /
 *      `backendStack` / `mainDependencies`, and simple string inequality
 *      for `applicationFlow`. The result is `{ explanation, changedSections
 *      }` — `changedSections` lists the human-readable section names that
 *      differ, so the caller can highlight exactly what changed since the
 *      last explanation, per requirement 8.3.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { EndpointEntry, RepositoryIndex, SymbolEntry } from '../../core/models';
import { IIndexer } from '../indexer/index-builder';
import { BedrockContext, IBedrockClient } from '../../services/bedrock-client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OmittedSection {
  title: string;
  reason: string;
}

export interface RepositoryExplanation {
  /** Detected frontend framework/library names (e.g. `['react']`). Omitted (undefined) if none detected. */
  frontendStack?: string[];
  /** Detected backend framework/library names (e.g. `['express']`). Omitted (undefined) if none detected. */
  backendStack?: string[];
  /** Top-level `dependencies` (not `devDependencies`) declared in package.json. */
  mainDependencies: string[];
  /** Bedrock-generated natural-language description of the main user-to-system flow. */
  applicationFlow: string;
  /** Sections that could not be generated/detected, with a reason for each (requirement 8.4). */
  omittedSections: OmittedSection[];
  /**
   * `true` when `applicationFlow` could not be generated by Bedrock (service
   * unavailable, internal/outer timeout, or query error) and instead holds
   * an explanatory placeholder message. The caller should offer the user a
   * way to retry, which is simply calling `explain()` again (requirement
   * 8.5) — see class-level doc comment #2.
   */
  flowGenerationFailed: boolean;
  generatedAt: Date;
}

export interface ReexplanationResult {
  explanation: RepositoryExplanation;
  /** Human-readable names of the top-level sections that changed since `previous` (requirement 8.3). */
  changedSections: string[];
}

export interface IRepositoryExplainer {
  explain(): Promise<RepositoryExplanation>;
  reexplain(previous: RepositoryExplanation): Promise<ReexplanationResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Requirement 8.1: overall time budget for generating the explanation. */
export const EXPLAIN_TIMEOUT_MS = 15_000;

/** Placeholder shown when Bedrock is unavailable/times out/errors (requirement 8.5). */
export const FLOW_UNAVAILABLE_MESSAGE =
  'No se pudo generar la descripción del flujo: Amazon Bedrock no está disponible.';

/** package.json dependency names (case-insensitive substring match) recognized as frontend frameworks. */
const FRONTEND_DEPENDENCY_MARKERS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^react($|-dom$)/, label: 'react' },
  { pattern: /^vue$/, label: 'vue' },
  { pattern: /^@angular\/core$/, label: 'angular' },
  { pattern: /^svelte$/, label: 'svelte' },
  { pattern: /^next$/, label: 'next.js' },
];

/** package.json dependency names (case-insensitive substring match) recognized as backend frameworks. */
const BACKEND_DEPENDENCY_MARKERS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^express$/, label: 'express' },
  { pattern: /^fastify$/, label: 'fastify' },
  { pattern: /^koa$/, label: 'koa' },
  { pattern: /^@nestjs\/core$/, label: 'nestjs' },
  { pattern: /^hapi$/, label: 'hapi' },
];

/** Max number of entry points (endpoints/components) included in the Bedrock prompt context. */
const MAX_FLOW_CONTEXT_ENTRIES = 8;

// ---------------------------------------------------------------------------
// package.json shape (only the fields this module reads)
// ---------------------------------------------------------------------------

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Generates repository explanations by combining deterministic, synchronous
 * stack/dependency detection (no Bedrock needed) with a Bedrock-generated
 * natural-language description of the application's main flow.
 */
export class RepositoryExplainer implements IRepositoryExplainer {
  constructor(
    private readonly indexSource: Pick<IIndexer, 'getIndex'>,
    private readonly bedrockClient: IBedrockClient,
    private readonly workspaceRoot: string,
    private readonly explainTimeoutMs: number = EXPLAIN_TIMEOUT_MS,
  ) {}

  async explain(): Promise<RepositoryExplanation> {
    return this.withTimeout(this.buildExplanation(), this.explainTimeoutMs);
  }

  async reexplain(previous: RepositoryExplanation): Promise<ReexplanationResult> {
    const explanation = await this.explain();
    return { explanation, changedSections: diffExplanations(previous, explanation) };
  }

  // -------------------------------------------------------------------
  // Explanation construction
  // -------------------------------------------------------------------

  private async buildExplanation(): Promise<RepositoryExplanation> {
    const index = this.indexSource.getIndex();
    const packageJson = await readPackageJson(this.workspaceRoot);

    const omittedSections: OmittedSection[] = [];

    const frontendStack = detectFrontendStack(index, packageJson);
    if (!frontendStack || frontendStack.length === 0) {
      omittedSections.push({ title: 'Stack de frontend', reason: 'No se detectó código de frontend.' });
    }

    const backendStack = detectBackendStack(index, packageJson);
    if (!backendStack || backendStack.length === 0) {
      omittedSections.push({ title: 'Stack de backend', reason: 'No se detectó código de backend.' });
    }

    const mainDependencies = extractMainDependencies(packageJson);

    const { applicationFlow, flowGenerationFailed } = await this.generateApplicationFlow(
      index,
      frontendStack,
      backendStack,
    );

    return {
      frontendStack: frontendStack && frontendStack.length > 0 ? frontendStack : undefined,
      backendStack: backendStack && backendStack.length > 0 ? backendStack : undefined,
      mainDependencies,
      applicationFlow,
      omittedSections,
      flowGenerationFailed,
      generatedAt: new Date(),
    };
  }

  /**
   * Requirement 8.2: uses Bedrock to produce a natural-language description
   * of the sequential steps from the user's initial action to the system's
   * response. Requirement 8.5: any Bedrock unavailability/timeout/error is
   * caught and reported via `flowGenerationFailed` rather than thrown.
   */
  private async generateApplicationFlow(
    index: RepositoryIndex,
    frontendStack: string[] | undefined,
    backendStack: string[] | undefined,
  ): Promise<{ applicationFlow: string; flowGenerationFailed: boolean }> {
    const available = await this.bedrockClient.isAvailable();
    if (!available) {
      return { applicationFlow: FLOW_UNAVAILABLE_MESSAGE, flowGenerationFailed: true };
    }

    try {
      const { prompt, context } = this.buildFlowPrompt(index, frontendStack, backendStack);
      const response = await this.bedrockClient.query(prompt, context);
      const trimmed = response.trim();
      if (trimmed.length === 0) {
        return { applicationFlow: FLOW_UNAVAILABLE_MESSAGE, flowGenerationFailed: true };
      }
      return { applicationFlow: trimmed, flowGenerationFailed: false };
    } catch {
      // BedrockTimeoutError, BedrockQueryError, BedrockTransmissionCancelledError,
      // or any other failure — all treated as "Bedrock unavailable" for this
      // section, per requirement 8.5.
      return { applicationFlow: FLOW_UNAVAILABLE_MESSAGE, flowGenerationFailed: true };
    }
  }

  private buildFlowPrompt(
    index: RepositoryIndex,
    frontendStack: string[] | undefined,
    backendStack: string[] | undefined,
  ): { prompt: string; context: BedrockContext } {
    const endpointDescriptions = index.endpoints
      .slice(0, MAX_FLOW_CONTEXT_ENTRIES)
      .map((endpoint) => `${endpoint.method} ${endpoint.route} (${relativePath(this.workspaceRoot, endpoint.filePath)})`);

    const componentNames = [...index.symbols.values()]
      .filter((symbol) => symbol.type === 'component')
      .slice(0, MAX_FLOW_CONTEXT_ENTRIES)
      .map((symbol) => `${symbol.name} (${relativePath(this.workspaceRoot, symbol.filePath)})`);

    const promptLines = [
      'Eres un asistente que ayuda a desarrolladores a entender rápidamente un repositorio nuevo.',
      `Stack de frontend detectado: ${frontendStack && frontendStack.length > 0 ? frontendStack.join(', ') : 'ninguno detectado'}.`,
      `Stack de backend detectado: ${backendStack && backendStack.length > 0 ? backendStack.join(', ') : 'ninguno detectado'}.`,
      `Endpoints principales detectados: ${endpointDescriptions.length > 0 ? endpointDescriptions.join('; ') : 'ninguno detectado'}.`,
      `Componentes principales detectados: ${componentNames.length > 0 ? componentNames.join('; ') : 'ninguno detectado'}.`,
      'Con base en esta información, describe en español, en un párrafo breve, el flujo principal de la ' +
        'aplicación: los pasos secuenciales desde la acción inicial del usuario hasta la respuesta del sistema. ' +
        'Responde únicamente con la descripción, sin texto adicional.',
    ];

    const files = [
      ...new Set([
        ...index.endpoints.slice(0, MAX_FLOW_CONTEXT_ENTRIES).map((endpoint) => relativePath(this.workspaceRoot, endpoint.filePath)),
        ...[...index.symbols.values()]
          .filter((symbol) => symbol.type === 'component')
          .slice(0, MAX_FLOW_CONTEXT_ENTRIES)
          .map((symbol) => relativePath(this.workspaceRoot, symbol.filePath)),
      ]),
    ];

    const context: BedrockContext = {
      files,
      codeSnippets: [...endpointDescriptions, ...componentNames],
      requiresConfirmation: true,
    };

    return { prompt: promptLines.join('\n\n'), context };
  }

  // -------------------------------------------------------------------
  // Timeout handling (requirement 8.1)
  // -------------------------------------------------------------------

  /**
   * Races `buildExplanation()` against `timeoutMs`. If the timeout wins,
   * returns a best-effort explanation using only the synchronous
   * (stack/dependency detection) data — computed fresh, since the original
   * promise's partial state isn't otherwise observable — with
   * `applicationFlow` set to a timeout placeholder. This never throws: the
   * user always gets *something* back, per design.md's error-handling table
   * ("Explicador de Repositorio | 15s | Informar al usuario. Ofrecer
   * reintento.").
   */
  private async withTimeout(
    promise: Promise<RepositoryExplanation>,
    timeoutMs: number,
  ): Promise<RepositoryExplanation> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const outcome = await Promise.race([promise, timeout]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (outcome !== 'timeout') {
      return outcome;
    }

    return this.buildPartialExplanationOnTimeout();
  }

  private async buildPartialExplanationOnTimeout(): Promise<RepositoryExplanation> {
    const index = this.indexSource.getIndex();
    const packageJson = await readPackageJson(this.workspaceRoot);

    const omittedSections: OmittedSection[] = [];
    const frontendStack = detectFrontendStack(index, packageJson);
    if (!frontendStack || frontendStack.length === 0) {
      omittedSections.push({ title: 'Stack de frontend', reason: 'No se detectó código de frontend.' });
    }
    const backendStack = detectBackendStack(index, packageJson);
    if (!backendStack || backendStack.length === 0) {
      omittedSections.push({ title: 'Stack de backend', reason: 'No se detectó código de backend.' });
    }

    return {
      frontendStack: frontendStack && frontendStack.length > 0 ? frontendStack : undefined,
      backendStack: backendStack && backendStack.length > 0 ? backendStack : undefined,
      mainDependencies: extractMainDependencies(packageJson),
      applicationFlow: FLOW_UNAVAILABLE_MESSAGE,
      omittedSections,
      flowGenerationFailed: true,
      generatedAt: new Date(),
    };
  }
}

// ---------------------------------------------------------------------------
// package.json reading
// ---------------------------------------------------------------------------

async function readPackageJson(workspaceRoot: string): Promise<PackageJsonShape> {
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, 'package.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as PackageJsonShape;
    }
    return {};
  } catch {
    // No package.json, unreadable, or invalid JSON — treated as "no
    // dependency information available" rather than a fatal error.
    return {};
  }
}

// ---------------------------------------------------------------------------
// Stack detection
// ---------------------------------------------------------------------------

/**
 * Detects the frontend stack from package.json dependencies and/or the
 * presence of `component`-typed symbols in the index (e.g. React
 * components extracted from .jsx/.tsx files by the Indexador). Returns
 * `undefined` when nothing is detected, so the caller can omit the section
 * (requirement 8.4).
 */
function detectFrontendStack(index: RepositoryIndex, packageJson: PackageJsonShape): string[] | undefined {
  const detected = new Set<string>();

  for (const depName of allDependencyNames(packageJson)) {
    for (const marker of FRONTEND_DEPENDENCY_MARKERS) {
      if (marker.pattern.test(depName)) {
        detected.add(marker.label);
      }
    }
  }

  const hasComponentSymbols = [...index.symbols.values()].some((symbol) => symbol.type === 'component');
  if (hasComponentSymbols && detected.size === 0) {
    detected.add('componentes de frontend (framework no identificado)');
  }

  return detected.size > 0 ? [...detected] : undefined;
}

/**
 * Detects the backend stack from package.json dependencies and/or the
 * presence of extracted `EndpointEntry` entries in the index. Returns
 * `undefined` when nothing is detected (requirement 8.4).
 */
function detectBackendStack(index: RepositoryIndex, packageJson: PackageJsonShape): string[] | undefined {
  const detected = new Set<string>();

  for (const depName of allDependencyNames(packageJson)) {
    for (const marker of BACKEND_DEPENDENCY_MARKERS) {
      if (marker.pattern.test(depName)) {
        detected.add(marker.label);
      }
    }
  }

  const hasEndpoints = index.endpoints.length > 0;
  if (hasEndpoints && detected.size === 0) {
    detected.add('endpoints de backend (framework no identificado)');
  }

  return detected.size > 0 ? [...detected] : undefined;
}

function allDependencyNames(packageJson: PackageJsonShape): string[] {
  return Object.keys(packageJson.dependencies ?? {});
}

/** Requirement 8.1: "principales dependencias" — top-level `dependencies` only, not `devDependencies`. */
function extractMainDependencies(packageJson: PackageJsonShape): string[] {
  return Object.keys(packageJson.dependencies ?? {});
}

// ---------------------------------------------------------------------------
// Diffing (requirement 8.3)
// ---------------------------------------------------------------------------

function diffExplanations(previous: RepositoryExplanation, current: RepositoryExplanation): string[] {
  const changed: string[] = [];

  if (!sameStringArray(previous.frontendStack, current.frontendStack)) {
    changed.push('Stack de frontend');
  }
  if (!sameStringArray(previous.backendStack, current.backendStack)) {
    changed.push('Stack de backend');
  }
  if (!sameStringArray(previous.mainDependencies, current.mainDependencies)) {
    changed.push('Principales dependencias');
  }
  if (previous.applicationFlow !== current.applicationFlow) {
    changed.push('Flujo principal de la aplicación');
  }

  return changed;
}

/** Order-independent array equality, treating `undefined` and `[]` as equivalent ("no entries"). */
function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
  const setA = new Set(a ?? []);
  const setB = new Set(b ?? []);
  if (setA.size !== setB.size) {
    return false;
  }
  for (const value of setA) {
    if (!setB.has(value)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function relativePath(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative.split(path.sep).join('/');
}

// Re-exported for callers/tests that only need the endpoint/symbol type info.
export type { EndpointEntry, SymbolEntry };
