import { describe, it, expect } from 'vitest';
import {
  SecretDetector,
  IFileContentReader,
  SECRET_PATTERN_LABELS,
  SecretCommitGate,
  ISecretConfirmationPrompt,
} from '../../../src/modules/pre-commit-reviewer/secret-detector';
import { SecretFinding } from '../../../src/modules/pre-commit-reviewer/pre-commit-reviewer';

const AWS_KEY_VALUE = 'AKIAIOSFODNN7EXAMPLE';
const JWT_VALUE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const GENERIC_SECRET_VALUE = 'hunter2Password';
const PRIVATE_KEY_HEADER = '-----BEGIN RSA PRIVATE KEY-----';

/** Stub `IFileContentReader` backed by an in-memory file map. */
class StubFileContentReader implements IFileContentReader {
  constructor(private readonly files: Record<string, string>) {}

  async readFile(filePath: string): Promise<string> {
    if (!(filePath in this.files)) {
      throw new Error(`ENOENT: no such file: ${filePath}`);
    }
    return this.files[filePath];
  }
}

/** Stub confirmation prompt that returns a fixed answer and records invocations. */
class StubConfirmationPrompt implements ISecretConfirmationPrompt {
  public calls: SecretFinding[][] = [];

  constructor(private readonly answer: boolean) {}

  async confirmProceedDespiteSecrets(findings: SecretFinding[]): Promise<boolean> {
    this.calls.push(findings);
    return this.answer;
  }
}

describe('SecretDetector', () => {
  it('detects an AWS-style access key and reports its location without the value', async () => {
    const filePath = '/repo/src/config.ts';
    const reader = new StubFileContentReader({
      [filePath]: `const key = "${AWS_KEY_VALUE}";\n`,
    });
    const detector = new SecretDetector(reader);

    const findings = await detector.detect([filePath]);

    expect(findings).toEqual([{ filePath, line: 1, pattern: SECRET_PATTERN_LABELS.AWS_ACCESS_KEY }]);
    expect(JSON.stringify(findings)).not.toContain(AWS_KEY_VALUE);
  });

  it('detects a private key block header', async () => {
    const filePath = '/repo/id_rsa';
    const reader = new StubFileContentReader({
      [filePath]: `${PRIVATE_KEY_HEADER}\nMIIBogIBAAJBAKl...\n-----END RSA PRIVATE KEY-----\n`,
    });
    const detector = new SecretDetector(reader);

    const findings = await detector.detect([filePath]);

    expect(findings).toEqual([{ filePath, line: 1, pattern: SECRET_PATTERN_LABELS.PRIVATE_KEY }]);
  });

  it('detects a generic credential assignment', async () => {
    const filePath = '/repo/src/env.ts';
    const reader = new StubFileContentReader({
      [filePath]: `export const config = {\n  password: "${GENERIC_SECRET_VALUE}",\n};\n`,
    });
    const detector = new SecretDetector(reader);

    const findings = await detector.detect([filePath]);

    expect(findings).toEqual([{ filePath, line: 2, pattern: SECRET_PATTERN_LABELS.GENERIC_CREDENTIAL }]);
    expect(JSON.stringify(findings)).not.toContain(GENERIC_SECRET_VALUE);
  });

  it('detects a JWT-like token', async () => {
    const filePath = '/repo/src/auth.ts';
    const reader = new StubFileContentReader({
      [filePath]: `const authHeader = "Bearer ${JWT_VALUE}";\n`,
    });
    const detector = new SecretDetector(reader);

    const findings = await detector.detect([filePath]);

    expect(findings).toEqual([{ filePath, line: 1, pattern: SECRET_PATTERN_LABELS.JWT_TOKEN }]);
    expect(JSON.stringify(findings)).not.toContain(JWT_VALUE);
  });

  it('produces no findings for a clean file', async () => {
    const filePath = '/repo/src/index.ts';
    const reader = new StubFileContentReader({
      [filePath]: `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    });
    const detector = new SecretDetector(reader);

    const findings = await detector.detect([filePath]);

    expect(findings).toEqual([]);
  });

  it('reports a scan error as a secret-like finding instead of silently skipping the file', async () => {
    const filePath = '/repo/src/unreadable.ts';
    const reader = new StubFileContentReader({}); // readFile throws for any path
    const detector = new SecretDetector(reader);

    const findings = await detector.detect([filePath]);

    expect(findings).toEqual([{ filePath, line: 1, pattern: SECRET_PATTERN_LABELS.SCAN_ERROR }]);
  });
});

describe('SecretCommitGate', () => {
  it('proceeds without prompting when no secrets were found', async () => {
    const prompt = new StubConfirmationPrompt(true);
    const gate = new SecretCommitGate(prompt);

    const result = await gate.evaluate([]);

    expect(result).toEqual({ secretsFound: false, proceed: true });
    expect(prompt.calls.length).toBe(0);
  });

  it('invokes the confirmation prompt with findings and proceeds when the user confirms', async () => {
    const finding: SecretFinding = { filePath: '/repo/a.ts', line: 3, pattern: SECRET_PATTERN_LABELS.AWS_ACCESS_KEY };
    const prompt = new StubConfirmationPrompt(true);
    const gate = new SecretCommitGate(prompt);

    const result = await gate.evaluate([finding]);

    expect(result).toEqual({ secretsFound: true, proceed: true });
    expect(prompt.calls).toEqual([[finding]]);
  });

  it('cancels when the user rejects the confirmation prompt', async () => {
    const finding: SecretFinding = { filePath: '/repo/a.ts', line: 3, pattern: SECRET_PATTERN_LABELS.PRIVATE_KEY };
    const prompt = new StubConfirmationPrompt(false);
    const gate = new SecretCommitGate(prompt);

    const result = await gate.evaluate([finding]);

    expect(result).toEqual({ secretsFound: true, proceed: false });
  });
});
