/**
 * Secret detection for the Revisor Pre-Commit (`modules/pre-commit-reviewer/`).
 *
 * Implements the `ISecretDetector` integration point left as a placeholder
 * by `pre-commit-reviewer.ts` (task 10.1), plus the commit-blocking /
 * explicit-confirmation UX required by requirements.md 6.3:
 *
 * > "WHEN el Revisor_Pre_Commit detecta posibles secretos o credenciales en
 * > los archivos del staging area, THE Revisor_Pre_Commit SHALL impedir que
 * > el commit se ejecute automáticamente, omitir el resumen del reporte y
 * > mostrar al Usuario una advertencia con la ubicación de cada secreto
 * > detectado, requiriendo acción explícita del Usuario para continuar o
 * > cancelar; IF el sistema de detección de secretos produce falsos
 * > positivos o errores de escaneo, THEN THE Revisor_Pre_Commit SHALL
 * > mostrar una advertencia al Usuario y requerir acción explícita para
 * > continuar o cancelar".
 *
 * ## Design decisions (documented rather than silent)
 *
 *   1. **Standalone pattern set, not extracted from `SecurityFilter`** —
 *      `services/security-filter.ts` (task 3.1) already has regexes for
 *      AWS keys / JWTs / connection strings / generic `key=value`
 *      assignments, but its `redactSensitiveValues` is a *text transform*
 *      (replace-in-place) with module-private regex constants that are not
 *      exported. This detector needs *locations* (file + line + pattern
 *      label), not a redacted copy of the text, and must never let the
 *      matched substring itself leave this module (not even transiently in
 *      a returned string). Exporting `SecurityFilter`'s regexes just to
 *      re-run them here would be a small change, but would also couple two
 *      modules with different jobs (privacy-preserving report redaction vs.
 *      commit-blocking detection) for the sake of avoiding a handful of
 *      near-duplicate regex literals — the same tradeoff `fix-confirmation.ts`
 *      and `bedrock-client.ts` already made deliberately for their two
 *      similarly-shaped confirmation-prompt interfaces. This module
 *      therefore defines its own self-contained pattern set below,
 *      conceptually aligned with (but not sharing code with)
 *      `SecurityFilter`'s.
 *
 *   2. **Scan errors are treated as secret-like findings, not silently
 *      skipped** — per 6.3's "IF" clause, a file that fails to scan (e.g.
 *      unreadable, binary/encoding issue) is conservatively reported as a
 *      `SecretFinding` with `pattern: 'scan-error-unconfirmed'` rather than
 *      being dropped. This reuses the exact same downstream flow (the
 *      commit gets blocked, the user sees a warning with the file's
 *      location, and must explicitly continue or cancel) instead of a
 *      separate error-handling path, since 6.3 asks for the same
 *      user-facing behavior in both cases.
 *
 *   3. **Confirmation orchestration lives entirely in this file, not in
 *      `pre-commit-reviewer.ts`** — `PreCommitReviewer.review()` is a pure
 *      "gather findings into a report" function; it does not itself
 *      execute `git commit`, and its class-level doc comment #4 explicitly
 *      states task 10.2 "only needs to provide a class implementing
 *      `ISecretDetector` ... no changes to this file's checks are
 *      required". Accordingly, `pre-commit-reviewer.ts` is left untouched.
 *      The "block commit automatically ... requiring explicit user action"
 *      behavior is exposed here as `SecretCommitGate`, which the (future)
 *      command handler that actually invokes `git commit` is expected to
 *      call with `report.secretsDetected` *before* proceeding — i.e.
 *      `review()` populates `secretsDetected`; `SecretCommitGate.evaluate`
 *      turns that into a blocking, explicit-confirmation decision.
 */

import * as fs from 'fs/promises';
import { ISecretDetector, SecretFinding } from './pre-commit-reviewer';

// ---------------------------------------------------------------------------
// Pattern labels & regexes (see design decision #1)
// ---------------------------------------------------------------------------

/** Short, non-value-bearing labels identifying the kind of secret found. */
export const SECRET_PATTERN_LABELS = {
  AWS_ACCESS_KEY: 'aws-access-key',
  PRIVATE_KEY: 'private-key',
  JWT_TOKEN: 'jwt-token',
  GENERIC_CREDENTIAL: 'generic-credential-assignment',
  /** Produced when a file could not be scanned (see design decision #2). */
  SCAN_ERROR: 'scan-error-unconfirmed',
} as const;

/** AWS-style access key IDs, e.g. AKIAIOSFODNN7EXAMPLE. */
const AWS_ACCESS_KEY_REGEX = /\bAKIA[0-9A-Z]{16}\b/;

/** PEM-style private key block headers (RSA, EC, DSA, OpenSSH, encrypted, generic). */
const PRIVATE_KEY_HEADER_REGEX = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

/**
 * JWT-like tokens: three base64url segments separated by dots. Uses
 * negative lookaround assertions instead of `\b` word-boundary anchors —
 * `-`/`_` are valid base64url characters but not `\w`, so a `\b` anchor
 * fails to match when a segment starts or ends with either (see
 * `security-filter.ts`'s `JWT_REGEX`, which was fixed for the identical
 * reason after a property test found a JWT ending in `-` was silently not
 * detected).
 */
const JWT_REGEX = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?![A-Za-z0-9_-])/;

/**
 * Generic `key = value` / `key: value` credential assignments, e.g.
 * `api_key=abc123`, `password: "hunter2"`, `token = 'xyz'`. Requires a
 * non-trivial (3+ char) value so that e.g. `token=""` or a bare `token=`
 * placeholder does not trigger a finding.
 */
const GENERIC_CREDENTIAL_REGEX =
  /\b(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|token|password|passwd|pwd|secret|auth[_-]?token)\s*[:=]\s*['"]?[^\s'",;]{3,}/i;

interface LinePatternCheck {
  label: string;
  regex: RegExp;
}

/**
 * Checked in this order per line. Every regex here is evaluated against a
 * single line (multi-line PEM bodies are not required — the `BEGIN`
 * header line alone is sufficient to flag and locate a private key block,
 * consistent with this module never needing to know the key's actual
 * contents).
 */
const LINE_PATTERN_CHECKS: readonly LinePatternCheck[] = [
  { label: SECRET_PATTERN_LABELS.PRIVATE_KEY, regex: PRIVATE_KEY_HEADER_REGEX },
  { label: SECRET_PATTERN_LABELS.AWS_ACCESS_KEY, regex: AWS_ACCESS_KEY_REGEX },
  { label: SECRET_PATTERN_LABELS.JWT_TOKEN, regex: JWT_REGEX },
  { label: SECRET_PATTERN_LABELS.GENERIC_CREDENTIAL, regex: GENERIC_CREDENTIAL_REGEX },
];

// ---------------------------------------------------------------------------
// Injectable file reading (mirrors dead-code-detector.ts's
// IFileContentReader / FsFileContentReader — kept local rather than shared,
// same reasoning as design decision #1: a small, self-contained interface
// per module rather than a premature shared abstraction).
// ---------------------------------------------------------------------------

export interface IFileContentReader {
  readFile(filePath: string): Promise<string>;
}

export class FsFileContentReader implements IFileContentReader {
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// SecretDetector (implements ISecretDetector from pre-commit-reviewer.ts)
// ---------------------------------------------------------------------------

/**
 * Scans staged files line-by-line for common secret/credential patterns.
 * Never returns or logs the matched substring itself — only
 * `{ filePath, line, pattern }`, where `pattern` is one of
 * `SECRET_PATTERN_LABELS`.
 */
export class SecretDetector implements ISecretDetector {
  constructor(private readonly fileReader: IFileContentReader = new FsFileContentReader()) {}

  async detect(stagedFiles: string[]): Promise<SecretFinding[]> {
    const findings: SecretFinding[] = [];

    for (const filePath of stagedFiles) {
      let content: string;
      try {
        content = await this.fileReader.readFile(filePath);
      } catch {
        // See design decision #2: a scan failure is reported the same way
        // a detected secret would be, so the user still gets a chance to
        // review/cancel rather than the file being silently skipped.
        findings.push({ filePath, line: 1, pattern: SECRET_PATTERN_LABELS.SCAN_ERROR });
        continue;
      }
      findings.push(...scanContentForSecrets(filePath, content));
    }

    return findings;
  }
}

function scanContentForSecrets(filePath: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const check of LINE_PATTERN_CHECKS) {
      if (check.regex.test(line)) {
        findings.push({ filePath, line: index + 1, pattern: check.label });
      }
    }
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Commit-blocking confirmation flow (requirements.md 6.3) — see design
// decision #3 for why this orchestration lives here rather than in
// pre-commit-reviewer.ts.
// ---------------------------------------------------------------------------

/**
 * Injectable abstraction over the warning dialog shown when secrets are
 * detected. Mirrors `bedrock-client.ts`'s `IConfirmationPrompt` /
 * `VsCodeConfirmationPrompt` and `fix-confirmation.ts`'s
 * `IFixConfirmationPrompt` / `VsCodeFixConfirmationPrompt` pattern: a
 * narrow, purpose-specific interface with a VS Code-backed default,
 * injectable so the gating logic is unit-testable outside an extension
 * host. `findings` is passed through so the prompt can show *locations*
 * (file + line + pattern label) — never the underlying secret value,
 * which this module never even holds in memory beyond the initial regex
 * test.
 */
export interface ISecretConfirmationPrompt {
  /** Resolves to `true` if the user explicitly chooses to continue despite the detected secrets, `false` to cancel. */
  confirmProceedDespiteSecrets(findings: SecretFinding[]): Promise<boolean>;
}

/**
 * Default confirmation prompt: shows every finding's location and pattern
 * label (never the matched value) via `vscode.window.showWarningMessage`,
 * with "Continuar" / "Cancelar" actions. Dismissing the dialog (e.g.
 * pressing Escape) is treated as cancellation, same as
 * `VsCodeConfirmationPrompt` / `VsCodeFixConfirmationPrompt`.
 */
export class VsCodeSecretConfirmationPrompt implements ISecretConfirmationPrompt {
  async confirmProceedDespiteSecrets(findings: SecretFinding[]): Promise<boolean> {
    // Imported lazily so this module's pure logic can be loaded and unit
    // tested without a VS Code extension host; only this default prompt
    // implementation touches `vscode`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode: typeof import('vscode') = require('vscode');

    const locations = findings.map((f) => `- ${f.filePath}:${f.line} (${f.pattern})`).join('\n');
    const message =
      'Pluvianidae detectó posibles secretos o credenciales en los archivos en staging:\n\n' +
      `${locations}\n\n` +
      'El commit ha sido bloqueado automáticamente. ¿Deseas continuar de todas formas o cancelar?';

    const CONTINUE = 'Continuar';
    const CANCEL = 'Cancelar';
    const selection = await vscode.window.showWarningMessage(message, { modal: true }, CONTINUE, CANCEL);
    return selection === CONTINUE;
  }
}

/** Outcome of `SecretCommitGate.evaluate`. */
export interface SecretGateResult {
  /** `true` when one or more secret-like findings were detected. */
  secretsFound: boolean;
  /**
   * Whether the commit should be allowed to proceed. `true` when no
   * secrets were found, or when the user explicitly chose to continue
   * despite them. `false` means the commit must be cancelled.
   */
  proceed: boolean;
}

/**
 * Turns a list of `SecretFinding`s (e.g. `PreCommitReport.secretsDetected`)
 * into a blocking, explicit-confirmation decision, per requirements.md 6.3.
 * The (future) command handler that actually runs `git commit` is expected
 * to call `evaluate` with the report's `secretsDetected` and only proceed
 * with the commit when `proceed` is `true`.
 */
export class SecretCommitGate {
  constructor(private readonly confirmationPrompt: ISecretConfirmationPrompt = new VsCodeSecretConfirmationPrompt()) {}

  async evaluate(secretsDetected: SecretFinding[]): Promise<SecretGateResult> {
    if (secretsDetected.length === 0) {
      return { secretsFound: false, proceed: true };
    }

    const proceed = await this.confirmationPrompt.confirmProceedDespiteSecrets(secretsDetected);
    return { secretsFound: true, proceed };
  }
}
