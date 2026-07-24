/**
 * README Generator (`modules/readme-generator/`).
 *
 * Analyzes the repository and produces a Markdown README draft, then
 * writes it to disk only after explicit user confirmation. See design.md >
 * "9. Generador de README (`modules/readme-generator/`)" and
 * requirements.md > Requirement 7 (7.1, 7.2, 7.3, 7.5, 7.6; 7.4/7.7 are
 * partially addressed here, see below).
 *
 * ## Sections and how each is derived
 *
 *   - **Descripción del proyecto**: Bedrock-generated natural-language
 *     summary based on `package.json`'s `name`/`description` plus a
 *     structural summary (file count, recognized tech stack). See "Bedrock
 *     fallback" below for what happens when Bedrock can't be used.
 *   - **Stack tecnológico**: deterministic extraction from
 *     `package.json`'s `dependencies`/`devDependencies` (no Bedrock — an
 *     LLM guess is less reliable than reading the manifest directly).
 *   - **Instalación**: boilerplate `<manager> install` command; the
 *     manager (`npm`/`yarn`/`pnpm`) is detected from the presence of a
 *     lockfile, defaulting to `npm` when none is found.
 *   - **Variables de entorno**: variable *names* only (never values,
 *     consistent with the Security Filter's redaction principle
 *     elsewhere), read from `.env.example`/`.env.sample` if present,
 *     otherwise inferred by scanning indexed source files for
 *     `process.env.X` / `import.meta.env.X` references (mirroring
 *     `frontend-extractor.ts`'s environment-variable handling).
 *   - **Scripts disponibles**: read directly from `package.json`'s
 *     `scripts` object.
 *   - **Estructura de carpetas**: a simple tree rendered from the index's
 *     file paths, truncated to the top `FOLDER_STRUCTURE_MAX_DEPTH` path
 *     segments (not an exhaustive per-file listing).
 *   - **Endpoints principales**: reuses `RepositoryIndex.endpoints`
 *     (already populated by the Indexador).
 *   - **Instrucciones para ejecutar frontend y backend**: a template
 *     combining detected `dev`/`start`/`build` scripts with recognized
 *     frontend/backend framework dependencies.
 *
 * Any section lacking sufficient data is omitted from `content` and
 * recorded in `omittedSections` with a human-readable reason
 * (requirements.md 7.5), rather than failing the whole draft.
 *
 * ## Bedrock fallback for the description section
 *
 * requirements.md 7.6 requires Bedrock for natural-language descriptions,
 * but doesn't say what to do when Bedrock is unavailable. Two options were
 * considered: (a) omit the description section entirely (mirroring
 * `Searcher`'s "Bedrock unavailable -> fall back to exact search" pattern
 * literally), or (b) degrade to a simpler, deterministic description built
 * from `package.json` alone. This implementation chooses (b): a project
 * with a `package.json` almost always has *some* describable identity (its
 * name, and often a one-line `description` field), so omitting the section
 * outright would throw away information that's trivially available without
 * Bedrock. The description section is therefore only omitted when there is
 * truly nothing to describe (no `package.json` AND no indexed files);
 * otherwise it always renders — using Bedrock's phrasing when available,
 * and the deterministic fallback when Bedrock is unavailable, times out, is
 * cancelled by the user, or errors.
 *
 * ## Combined 7.2 / 7.7 confirmation
 *
 * requirements.md splits confirmation into two moments: 7.2 asks for
 * confirmation of the *draft content*, and 7.7 asks for a *second*,
 * separate confirmation of the *file location* once the draft is accepted.
 * `applyDraft` implements both as a **single** combined dialog
 * (`IReadmeConfirmationPrompt.confirmWrite`) that shows the draft preview,
 * the list of omitted sections, and the exact target path (defaulting to
 * `README.md` at the workspace root) all at once, requiring one explicit
 * confirmation before anything is written. This satisfies the substance of
 * both requirements — the user sees the content AND the destination before
 * any file is touched — without the added UI friction of two sequential
 * modal dialogs for what is, in this MVP, always the same default path. If
 * a future revision needs true alternate-path selection, that would be a
 * natural extension of `IReadmeConfirmationPrompt` (e.g. returning a chosen
 * path alongside the confirmation boolean) rather than a second dialog.
 *
 * ## Diff integration point (task 11.2)
 *
 * requirements.md 7.4 ("mostrar las diferencias entre el README existente y
 * el borrador propuesto") is task 11.2's responsibility. This module
 * defines the integration point for it: `ReadmeDiffComputer`, an injectable
 * function `(existingContent, draftContent) => diff | undefined` that
 * `generateDraft()` always calls (after reading the existing `README.md`,
 * if any) to populate `ReadmeDraft.diff`. The default constructor
 * parameter is `noopReadmeDiffComputer` (always returns `undefined`);
 * task 11.2's real implementation, `computeReadmeDiff`
 * (`readme-diff.ts`), is supplied explicitly by callers that want diffing
 * (mirroring `pre-commit-reviewer.ts` leaving `secretDetector`'s default as
 * `NoOpSecretDetector` rather than importing `secret-detector.ts`
 * directly), so this file's generation logic did not need to change.
 * `VsCodeReadmeConfirmationPrompt.confirmWrite` renders `draft.diff` (when
 * present) as part of the same confirmation dialog, satisfying "incluir el
 * diff en el diálogo de confirmación".
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { EndpointEntry, RepositoryIndex } from '../../core/models';
import { IIndexer } from '../indexer/index-builder';
import { BedrockContext, IBedrockClient } from '../../services/bedrock-client';

// ---------------------------------------------------------------------------
// Public types (design.md > "9. Generador de README")
// ---------------------------------------------------------------------------

export interface IReadmeGenerator {
  generateDraft(): Promise<ReadmeDraft>;
  applyDraft(draft: ReadmeDraft): Promise<void>;
}

export interface ReadmeDraft {
  content: string;
  sections: ReadmeSection[];
  omittedSections: OmittedSection[];
  /** Diferencias con el README existente. `undefined` until task 11.2 supplies a real `ReadmeDiffComputer`. */
  diff?: string;
}

export interface ReadmeSection {
  title: string;
  content: string;
}

export interface OmittedSection {
  title: string;
  reason: string;
}

/** Soft time budget for `generateDraft()`, per requirements.md 7.1 — logged, not enforced as a hard abort. */
export const README_GENERATION_SOFT_TIMEOUT_MS = 30_000;

/** Default target file name/path (relative to the workspace root) written by `applyDraft`. */
export const DEFAULT_README_FILENAME = 'README.md';

/** Maximum path-segment depth rendered by the folder structure section. */
const FOLDER_STRUCTURE_MAX_DEPTH = 3;

/** Characters of `draft.content` shown verbatim in the confirmation dialog before truncating with an ellipsis. */
const README_PREVIEW_LENGTH = 1500;

// ---------------------------------------------------------------------------
// Diff integration point (task 11.2 hook)
// ---------------------------------------------------------------------------

/**
 * Computes a diff between the existing README's content (`undefined` if
 * there is no existing README) and the newly generated draft content.
 * Injected into `ReadmeGenerator` so task 11.2 can supply a real
 * implementation without changing `generateDraft()`'s logic.
 */
export type ReadmeDiffComputer = (existingContent: string | undefined, draftContent: string) => string | undefined;

/** Default `ReadmeDiffComputer`: no diffing yet — task 11.2 implements this. */
export const noopReadmeDiffComputer: ReadmeDiffComputer = () => undefined;

// ---------------------------------------------------------------------------
// Filesystem abstraction (injectable, mirrors dead-code-detector's
// IFileEditor / FsFileEditor pattern)
// ---------------------------------------------------------------------------

/**
 * Narrow filesystem abstraction covering exactly what the README Generator
 * needs (read package.json/.env.example/source files, check for lockfiles
 * and an existing README, write the final README). Kept separate from
 * `dead-code-detector`'s `IFileEditor` since that interface also exposes
 * `deleteFile`, which has no meaning here.
 */
export interface IReadmeFileSystem {
  readFile(filePath: string): Promise<string>;
  fileExists(filePath: string): Promise<boolean>;
  writeFile(filePath: string, content: string): Promise<void>;
}

export class FsReadmeFileSystem implements IReadmeFileSystem {
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Confirmation prompt (injectable, mirrors bedrock-client.ts's
// IConfirmationPrompt / VsCodeConfirmationPrompt pattern)
// ---------------------------------------------------------------------------

/**
 * Injectable abstraction over the single combined confirmation dialog
 * described above (7.2 + 7.7 merged). The default implementation uses
 * `vscode.window.showInformationMessage`; tests supply a stub so the flow
 * can be exercised without a real VS Code UI.
 */
export interface IReadmeConfirmationPrompt {
  /** Resolves to `true` if the user confirms writing `draft` to `targetPath`, `false` if they reject it. */
  confirmWrite(draft: ReadmeDraft, targetPath: string): Promise<boolean>;
}

/**
 * Default confirmation prompt: shows the target path, a preview of the
 * draft content, and any omitted sections, with "Escribir README" /
 * "Cancelar" actions, plus a "Ver borrador completo" action that opens the
 * full draft in an untitled Markdown editor and then re-shows the dialog
 * (so the user can review everything before the final decision). Dismissing
 * the dialog (e.g. pressing Escape) is treated as rejection, same as
 * `VsCodeConfirmationPrompt` in `bedrock-client.ts`.
 */
export class VsCodeReadmeConfirmationPrompt implements IReadmeConfirmationPrompt {
  async confirmWrite(draft: ReadmeDraft, targetPath: string): Promise<boolean> {
    // Imported lazily so this module (and the rest of this file's pure
    // logic) can be loaded and unit tested without a VS Code extension
    // host; only this default prompt implementation touches `vscode`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    const CONFIRM = 'Escribir README';
    const VIEW = 'Ver borrador completo';
    const CANCEL = 'Cancelar';

    const omittedNote =
      draft.omittedSections.length > 0
        ? `\n\nSecciones omitidas (sin datos suficientes):\n${draft.omittedSections
            .map((section) => `- ${section.title}: ${section.reason}`)
            .join('\n')}`
        : '';
    // requirements.md 7.4: when there is an existing README, `draft.diff`
    // (populated by `generateDraft()` via the injected `ReadmeDiffComputer`,
    // see task 11.2's `readme-diff.ts`) is shown as part of this same
    // confirmation proposal, alongside the omitted-sections note.
    const diffNote = draft.diff ? `\n\nDiferencias con el README existente:\n${draft.diff}` : '';
    const preview =
      draft.content.length > README_PREVIEW_LENGTH ? `${draft.content.slice(0, README_PREVIEW_LENGTH)}…` : draft.content;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const message =
        `Pluvianidae generó un borrador de README y lo escribirá en:\n${targetPath}\n\n` +
        `Vista previa:\n${preview}${omittedNote}${diffNote}`;

      const selection = await vscode.window.showInformationMessage(message, { modal: true }, CONFIRM, VIEW, CANCEL);

      if (selection === CONFIRM) {
        return true;
      }
      if (selection === VIEW) {
        const doc = await vscode.workspace.openTextDocument({ content: draft.content, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true });
        continue; // re-show the confirmation dialog after the user reviews the full draft
      }
      return false; // CANCEL or dismissed (Escape)
    }
  }
}

// ---------------------------------------------------------------------------
// package.json shape (only the fields this module reads)
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Recognized dependency -> human-readable label, used for both the tech stack section and description/run-instructions heuristics. */
const KNOWN_TECH_LABELS: Readonly<Record<string, string>> = {
  react: 'React (frontend)',
  'react-dom': 'React DOM',
  next: 'Next.js (frontend)',
  vue: 'Vue (frontend)',
  '@angular/core': 'Angular (frontend)',
  svelte: 'Svelte (frontend)',
  express: 'Express (backend)',
  koa: 'Koa (backend)',
  fastify: 'Fastify (backend)',
  '@nestjs/core': 'NestJS (backend)',
  mongoose: 'Mongoose (ORM MongoDB)',
  prisma: 'Prisma (ORM)',
  sequelize: 'Sequelize (ORM)',
  typeorm: 'TypeORM (ORM)',
  graphql: 'GraphQL',
  'apollo-server': 'Apollo Server (GraphQL)',
  'socket.io': 'Socket.IO',
  typescript: 'TypeScript',
  vitest: 'Vitest (testing)',
  jest: 'Jest (testing)',
  mocha: 'Mocha (testing)',
  cypress: 'Cypress (testing E2E)',
  playwright: 'Playwright (testing E2E)',
  eslint: 'ESLint (linting)',
  webpack: 'Webpack (bundler)',
  vite: 'Vite (bundler)',
  tailwindcss: 'Tailwind CSS',
  bootstrap: 'Bootstrap',
  'styled-components': 'styled-components',
  redux: 'Redux',
  mobx: 'MobX',
  axios: 'Axios (cliente HTTP)',
};

const FRONTEND_PACKAGE_NAMES: readonly string[] = ['react', 'next', 'vue', '@angular/core', 'svelte'];
const BACKEND_PACKAGE_NAMES: readonly string[] = ['express', 'koa', 'fastify', '@nestjs/core'];

/** Matches `process.env.FOO` and `import.meta.env.FOO` references in source files. */
const ENV_VAR_USAGE_PATTERN = /(?:process\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** Matches a `KEY=value` (or `KEY=`) assignment line in a `.env.example`-style file, ignoring comments/blank lines. */
const ENV_FILE_ASSIGNMENT_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// ---------------------------------------------------------------------------
// Section-building outcome
// ---------------------------------------------------------------------------

interface SectionOutcome {
  section?: ReadmeSection;
  omitted?: OmittedSection;
}

function collectOutcome(outcome: SectionOutcome, sections: ReadmeSection[], omittedSections: OmittedSection[]): void {
  if (outcome.section) {
    sections.push(outcome.section);
  }
  if (outcome.omitted) {
    omittedSections.push(outcome.omitted);
  }
}

// ---------------------------------------------------------------------------
// ReadmeGenerator
// ---------------------------------------------------------------------------

/**
 * Implements `IReadmeGenerator`: analyzes the repository (via the already-
 * built `RepositoryIndex` and `package.json`) to produce a `ReadmeDraft`,
 * and writes it to disk only after explicit combined confirmation.
 */
export class ReadmeGenerator implements IReadmeGenerator {
  constructor(
    private readonly indexSource: Pick<IIndexer, 'getIndex'>,
    private readonly bedrockClient: IBedrockClient,
    private readonly workspaceRoot: string,
    private readonly fileSystem: IReadmeFileSystem = new FsReadmeFileSystem(),
    private readonly confirmationPrompt: IReadmeConfirmationPrompt = new VsCodeReadmeConfirmationPrompt(),
    private readonly diffComputer: ReadmeDiffComputer = noopReadmeDiffComputer,
  ) {}

  async generateDraft(): Promise<ReadmeDraft> {
    const startTime = Date.now();

    const pkg = await this.readPackageJson();
    const index = this.indexSource.getIndex();

    const sections: ReadmeSection[] = [];
    const omittedSections: OmittedSection[] = [];

    // Order matches requirements.md 7.1's enumeration.
    collectOutcome(await this.buildDescriptionSection(pkg, index), sections, omittedSections);
    collectOutcome(this.buildTechStackSection(pkg), sections, omittedSections);
    collectOutcome(await this.buildInstallationSection(pkg), sections, omittedSections);
    collectOutcome(await this.buildEnvVarsSection(index), sections, omittedSections);
    collectOutcome(this.buildScriptsSection(pkg), sections, omittedSections);
    collectOutcome(this.buildFolderStructureSection(index), sections, omittedSections);
    collectOutcome(this.buildEndpointsSection(index), sections, omittedSections);
    collectOutcome(this.buildRunInstructionsSection(pkg), sections, omittedSections);

    const content = assembleMarkdown(sections);

    const targetPath = this.getTargetPath();
    const existingContent = await this.readExistingReadme(targetPath);
    const diff = this.diffComputer(existingContent, content);

    const elapsed = Date.now() - startTime;
    if (elapsed > README_GENERATION_SOFT_TIMEOUT_MS) {
      // Soft target per requirements.md 7.1: log and continue with the
      // completed draft, do not abort — mirrors IncrementalIndexer's
      // soft-timeout handling.
      // eslint-disable-next-line no-console
      console.warn(
        `[Pluvianidae] README draft generation took ${elapsed}ms, exceeding the ` +
          `${README_GENERATION_SOFT_TIMEOUT_MS}ms target. The draft was completed anyway.`,
      );
    }

    return { content, sections, omittedSections, diff };
  }

  async applyDraft(draft: ReadmeDraft): Promise<void> {
    const targetPath = this.getTargetPath();
    const confirmed = await this.confirmationPrompt.confirmWrite(draft, targetPath);
    if (!confirmed) {
      // requirements.md 7.3: discard the draft, preserve the existing
      // README untouched, write nothing.
      return;
    }
    await this.fileSystem.writeFile(targetPath, draft.content);
  }

  // -------------------------------------------------------------------
  // package.json / existing README reading
  // -------------------------------------------------------------------

  private getTargetPath(): string {
    return path.join(this.workspaceRoot, DEFAULT_README_FILENAME);
  }

  private async readPackageJson(): Promise<PackageJson | undefined> {
    try {
      const raw = await this.fileSystem.readFile(path.join(this.workspaceRoot, 'package.json'));
      return JSON.parse(raw) as PackageJson;
    } catch {
      return undefined;
    }
  }

  private async readExistingReadme(targetPath: string): Promise<string | undefined> {
    try {
      if (await this.fileSystem.fileExists(targetPath)) {
        return await this.fileSystem.readFile(targetPath);
      }
    } catch {
      // Unreadable existing README: treat as if there were none, rather
      // than failing draft generation over it.
    }
    return undefined;
  }

  // -------------------------------------------------------------------
  // Descripción del proyecto
  // -------------------------------------------------------------------

  private async buildDescriptionSection(pkg: PackageJson | undefined, index: RepositoryIndex): Promise<SectionOutcome> {
    const fileCount = index.files.size;
    if (!pkg && fileCount === 0) {
      return {
        omitted: {
          title: 'Descripción del proyecto',
          reason: 'No se encontró información suficiente para generar una descripción (falta package.json y no hay archivos indexados).',
        },
      };
    }

    const techSummary = this.summarizeTechStack(pkg);
    const fallback = buildFallbackDescription(pkg, fileCount, techSummary);

    try {
      const available = await this.bedrockClient.isAvailable();
      if (!available) {
        return { section: { title: 'Descripción del proyecto', content: fallback } };
      }

      const prompt = buildDescriptionPrompt(pkg, fileCount, techSummary);
      const context: BedrockContext = {
        files: ['package.json'],
        codeSnippets: [
          JSON.stringify({ name: pkg?.name, description: pkg?.description, fileCount, techSummary }, null, 2),
        ],
        requiresConfirmation: true,
      };
      const response = await this.bedrockClient.query(prompt, context);
      const trimmed = response.trim();
      return { section: { title: 'Descripción del proyecto', content: trimmed.length > 0 ? trimmed : fallback } };
    } catch {
      // Bedrock unavailable, timed out, cancelled by the user, or errored:
      // degrade to the deterministic fallback rather than omitting the
      // section or failing the whole draft — see this file's top comment
      // ("Bedrock fallback for the description section").
      return { section: { title: 'Descripción del proyecto', content: fallback } };
    }
  }

  private summarizeTechStack(pkg: PackageJson | undefined): string {
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const recognized = Object.keys(deps)
      .filter((name) => KNOWN_TECH_LABELS[name])
      .map((name) => KNOWN_TECH_LABELS[name]);
    return recognized.length > 0 ? recognized.join(', ') : 'sin dependencias reconocidas';
  }

  // -------------------------------------------------------------------
  // Stack tecnológico
  // -------------------------------------------------------------------

  private buildTechStackSection(pkg: PackageJson | undefined): SectionOutcome {
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const depNames = Object.keys(deps);
    if (depNames.length === 0) {
      return {
        omitted: {
          title: 'Stack tecnológico',
          reason: 'No se encontró información de dependencias (falta package.json o no declara dependencias).',
        },
      };
    }

    const recognized = depNames.filter((name) => KNOWN_TECH_LABELS[name]);
    const other = depNames.filter((name) => !KNOWN_TECH_LABELS[name]);

    const lines = recognized.map((name) => `- ${KNOWN_TECH_LABELS[name]}`);
    if (other.length > 0) {
      lines.push(`- Otras dependencias: ${other.join(', ')}`);
    }

    return { section: { title: 'Stack tecnológico', content: lines.join('\n') } };
  }

  // -------------------------------------------------------------------
  // Instalación
  // -------------------------------------------------------------------

  private async buildInstallationSection(pkg: PackageJson | undefined): Promise<SectionOutcome> {
    if (!pkg) {
      return { omitted: { title: 'Instalación', reason: 'No se encontró package.json.' } };
    }

    const manager = await this.detectPackageManager();
    return { section: { title: 'Instalación', content: `\`\`\`bash\n${manager} install\n\`\`\`` } };
  }

  private async detectPackageManager(): Promise<'npm' | 'yarn' | 'pnpm'> {
    if (await this.fileSystem.fileExists(path.join(this.workspaceRoot, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (await this.fileSystem.fileExists(path.join(this.workspaceRoot, 'yarn.lock'))) {
      return 'yarn';
    }
    return 'npm';
  }

  // -------------------------------------------------------------------
  // Variables de entorno
  // -------------------------------------------------------------------

  private async buildEnvVarsSection(index: RepositoryIndex): Promise<SectionOutcome> {
    const fromExample = await this.readEnvExampleVariableNames();
    const names = fromExample.length > 0 ? fromExample : await this.scanSourceForEnvVarNames(index);

    if (names.length === 0) {
      return { omitted: { title: 'Variables de entorno', reason: 'No se detectaron variables de entorno.' } };
    }

    return {
      section: { title: 'Variables de entorno', content: names.map((name) => `- \`${name}\``).join('\n') },
    };
  }

  private async readEnvExampleVariableNames(): Promise<string[]> {
    for (const candidate of ['.env.example', '.env.sample']) {
      const filePath = path.join(this.workspaceRoot, candidate);
      if (!(await this.fileSystem.fileExists(filePath))) {
        continue;
      }
      try {
        const content = await this.fileSystem.readFile(filePath);
        const names = extractEnvVarNamesFromEnvFile(content);
        if (names.length > 0) {
          return names;
        }
      } catch {
        // Unreadable candidate: try the next one.
      }
    }
    return [];
  }

  /**
   * Scans every indexed file's contents for `process.env.X` /
   * `import.meta.env.X` references, used as a fallback when no
   * `.env.example`/`.env.sample` is present. This re-reads files from disk
   * (the index itself only stores structural metadata, not source text),
   * mirroring `frontend-extractor.ts`'s handling of env-var-derived URLs.
   */
  private async scanSourceForEnvVarNames(index: RepositoryIndex): Promise<string[]> {
    const names = new Set<string>();
    for (const filePath of index.files.keys()) {
      try {
        const content = await this.fileSystem.readFile(filePath);
        for (const match of content.matchAll(ENV_VAR_USAGE_PATTERN)) {
          names.add(match[1]);
        }
      } catch {
        // Unreadable file: skip silently, consistent with other modules'
        // error-resilience pattern (continue with the rest).
      }
    }
    return [...names].sort();
  }

  // -------------------------------------------------------------------
  // Scripts disponibles
  // -------------------------------------------------------------------

  private buildScriptsSection(pkg: PackageJson | undefined): SectionOutcome {
    const scripts = pkg?.scripts ?? {};
    const names = Object.keys(scripts);
    if (names.length === 0) {
      return { omitted: { title: 'Scripts disponibles', reason: 'No se encontraron scripts en package.json.' } };
    }

    const content = names.map((name) => `- \`npm run ${name}\`: ${scripts[name]}`).join('\n');
    return { section: { title: 'Scripts disponibles', content } };
  }

  // -------------------------------------------------------------------
  // Estructura de carpetas
  // -------------------------------------------------------------------

  private buildFolderStructureSection(index: RepositoryIndex): SectionOutcome {
    const relativePaths = [...index.files.values()]
      .map((file) => file.relativePath)
      .filter((relativePath) => relativePath.length > 0)
      .sort();

    if (relativePaths.length === 0) {
      return {
        omitted: {
          title: 'Estructura de carpetas',
          reason: 'No se encontraron archivos indexados para construir la estructura de carpetas.',
        },
      };
    }

    const tree = buildFolderTree(relativePaths, FOLDER_STRUCTURE_MAX_DEPTH);
    const lines = renderFolderTree(tree);
    return { section: { title: 'Estructura de carpetas', content: `\`\`\`\n${lines.join('\n')}\n\`\`\`` } };
  }

  // -------------------------------------------------------------------
  // Endpoints principales
  // -------------------------------------------------------------------

  private buildEndpointsSection(index: RepositoryIndex): SectionOutcome {
    if (index.endpoints.length === 0) {
      return { omitted: { title: 'Endpoints principales', reason: 'No se detectaron endpoints backend.' } };
    }

    const content = index.endpoints
      .map((endpoint) => `- **${endpoint.method}** ${endpoint.route} (\`${this.toDisplayPath(endpoint)}:${endpoint.line}\`)`)
      .join('\n');
    return { section: { title: 'Endpoints principales', content } };
  }

  private toDisplayPath(endpoint: EndpointEntry): string {
    return path.relative(this.workspaceRoot, endpoint.filePath).split(path.sep).join('/');
  }

  // -------------------------------------------------------------------
  // Instrucciones para ejecutar frontend y backend
  // -------------------------------------------------------------------

  private buildRunInstructionsSection(pkg: PackageJson | undefined): SectionOutcome {
    const scripts = pkg?.scripts ?? {};
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const hasFrontend = FRONTEND_PACKAGE_NAMES.some((name) => name in deps);
    const hasBackend = BACKEND_PACKAGE_NAMES.some((name) => name in deps);

    const lines: string[] = [];
    if (scripts.dev) {
      lines.push(
        `- Ejecuta \`npm run dev\` para iniciar ${hasFrontend ? 'el servidor de desarrollo del frontend' : 'el proyecto en modo desarrollo'}.`,
      );
    }
    if (scripts.start) {
      lines.push(`- Ejecuta \`npm start\` para iniciar ${hasBackend ? 'el servidor backend' : 'la aplicación'}.`);
    }
    if (scripts.build) {
      lines.push('- Ejecuta `npm run build` para generar la build de producción.');
    }

    if (lines.length === 0) {
      return {
        omitted: {
          title: 'Instrucciones para ejecutar frontend y backend',
          reason: 'No se pudo determinar cómo ejecutar el proyecto (no se detectaron scripts "dev"/"start"/"build" ni frameworks conocidos).',
        },
      };
    }

    return { section: { title: 'Instrucciones para ejecutar frontend y backend', content: lines.join('\n') } };
  }
}

// ---------------------------------------------------------------------------
// Free helper functions
// ---------------------------------------------------------------------------

function assembleMarkdown(sections: ReadmeSection[]): string {
  const header = '# README (borrador generado por Pluvianidae)\n';
  const body = sections.map((section) => `## ${section.title}\n\n${section.content}`).join('\n\n');
  return `${header}\n${body}\n`;
}

function buildFallbackDescription(pkg: PackageJson | undefined, fileCount: number, techSummary: string): string {
  const name = pkg?.name ?? 'Este proyecto';
  const description = pkg?.description ? ` ${pkg.description}` : '';
  return `${name}.${description} Contiene ${fileCount} archivo(s) indexado(s). Tecnologías detectadas: ${techSummary}.`;
}

function buildDescriptionPrompt(pkg: PackageJson | undefined, fileCount: number, techSummary: string): string {
  return [
    'Eres un asistente que redacta la sección de descripción de un README.',
    `Nombre del proyecto: ${pkg?.name ?? '(desconocido)'}`,
    `Descripción declarada en package.json: ${pkg?.description ?? '(ninguna)'}`,
    `Archivos indexados: ${fileCount}`,
    `Tecnologías detectadas: ${techSummary}`,
    'Redacta un párrafo breve (2-4 oraciones) en español que describa el propósito y la naturaleza del ' +
      'proyecto para un README. Responde únicamente con el texto del párrafo, sin encabezados ni comillas.',
  ].join('\n');
}

/** Extracts variable names from `KEY=value` lines in a `.env.example`-style file, ignoring comments/blank lines. */
function extractEnvVarNamesFromEnvFile(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const match = ENV_FILE_ASSIGNMENT_PATTERN.exec(trimmed);
    if (match) {
      names.push(match[1]);
    }
  }
  return names;
}

/** Simple tree node used to render the folder structure section. */
interface FolderTreeNode {
  children: Map<string, FolderTreeNode>;
}

/**
 * Builds a tree limited to the first `maxDepth` path segments of each
 * relative path. Paths deeper than `maxDepth` still contribute their
 * ancestor directory (rendered without expanding further), keeping the
 * output a high-level overview rather than an exhaustive file listing.
 */
function buildFolderTree(relativePaths: string[], maxDepth: number): FolderTreeNode {
  const root: FolderTreeNode = { children: new Map() };

  for (const relativePath of relativePaths) {
    const segments = relativePath.split('/').slice(0, maxDepth);
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
  }

  return root;
}

function renderFolderTree(node: FolderTreeNode, prefix = ''): string[] {
  const lines: string[] = [];
  const sortedNames = [...node.children.keys()].sort();

  for (const name of sortedNames) {
    const child = node.children.get(name)!;
    const isDirectory = child.children.size > 0;
    lines.push(`${prefix}${name}${isDirectory ? '/' : ''}`);
    if (isDirectory) {
      lines.push(...renderFolderTree(child, `${prefix}  `));
    }
  }

  return lines;
}
