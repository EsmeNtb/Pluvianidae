import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SecretDetector,
  IFileContentReader,
  SECRET_PATTERN_LABELS,
  SecretCommitGate,
  ISecretConfirmationPrompt,
} from '../../src/modules/pre-commit-reviewer/secret-detector';
import { SecretFinding } from '../../src/modules/pre-commit-reviewer/pre-commit-reviewer';

// Feature: pluvianidae-mvp, Property 17: Secret pattern detection
//
// "For any file content containing strings matching API key, token,
// password, or private key patterns, the Revisor_Pre_Commit SHALL detect
// all matches and the presence of any secret SHALL trigger commit
// blocking."
// Validates: Requirements 6.3 (see design.md Property 17; requirements.md 6.3/6.4/6.5)

const NUM_RUNS = 75;

// ---------------------------------------------------------------------------
// Fakes (mirrors tests/unit/pre-commit-reviewer/secret-detector.test.ts)
// ---------------------------------------------------------------------------

/** Fake `IFileContentReader` backed by an in-memory file map. */
class FakeFileContentReader implements IFileContentReader {
  constructor(private readonly files: Record<string, string>) {}

  async readFile(filePath: string): Promise<string> {
    if (!(filePath in this.files)) {
      throw new Error(`ENOENT: no such file: ${filePath}`);
    }
    return this.files[filePath];
  }
}

/** Fake confirmation prompt that returns a fixed answer and records invocations. */
class FakeConfirmationPrompt implements ISecretConfirmationPrompt {
  public calls: SecretFinding[][] = [];

  constructor(private readonly answer: boolean) {}

  async confirmProceedDespiteSecrets(findings: SecretFinding[]): Promise<boolean> {
    this.calls.push(findings);
    return this.answer;
  }
}

// ---------------------------------------------------------------------------
// Safe surrounding-text generation.
//
// Built from a small fixed vocabulary of plain Latin words that cannot, by
// construction, accidentally match any of the secret patterns under test
// (no digits, no "=" / ":" separators, no occurrences of the pattern
// keywords like "key"/"token"/"password"/"secret"/"auth", no "AKIA"/"eyJ"
// substrings, no "-----BEGIN" sequences). This avoids the generator
// accidentally producing false-positive lines that would make the
// "exactly one finding at the expected line" assertions flaky.
// ---------------------------------------------------------------------------

const SAFE_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation',
  'ullamco', 'nisi', 'aliquip', 'commodo', 'duis', 'aute', 'irure', 'reprehenderit',
];

/** A single "safe" line of plain text (0-6 words), guaranteed not to match any secret pattern. */
const safeLineArbitrary = fc
  .array(fc.constantFrom(...SAFE_WORDS), { minLength: 0, maxLength: 6 })
  .map((words) => words.join(' '));

/** 0-4 safe lines, used as filler before/after the embedded secret line. */
const safeLinesBlockArbitrary = fc.array(safeLineArbitrary, { minLength: 0, maxLength: 4 });

/** A safe path segment, used for file names / variable names that must not collide with any keyword. */
const safeWordArbitrary = fc.constantFrom(...SAFE_WORDS);

// ---------------------------------------------------------------------------
// Secret-shaped line generators, each tagged with the pattern label the
// implementation is expected to report and (when applicable) the raw
// secret value that must never leak into the findings.
// ---------------------------------------------------------------------------

interface SecretLine {
  line: string;
  label: string;
  secretValue?: string;
}

/** `const <safe> = "AKIA<16 upper alnum chars>";` */
const awsKeyLineArbitrary: fc.Arbitrary<SecretLine> = fc
  .tuple(safeWordArbitrary, fc.stringMatching(/^[0-9A-Z]{16}$/))
  .map(([name, suffix]) => {
    const secretValue = `AKIA${suffix}`;
    return {
      line: `const ${name} = "${secretValue}";`,
      label: SECRET_PATTERN_LABELS.AWS_ACCESS_KEY,
      secretValue,
    };
  });

/** `-----BEGIN [prefix ]PRIVATE KEY-----` */
const privateKeyLineArbitrary: fc.Arbitrary<SecretLine> = fc
  .constantFrom('', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ')
  .map((prefix) => ({
    line: `-----BEGIN ${prefix}PRIVATE KEY-----`,
    label: SECRET_PATTERN_LABELS.PRIVATE_KEY,
  }));

/** `const <safe> = "Bearer eyJ<seg1>.<seg2>.<seg3>";` */
const jwtLineArbitrary: fc.Arbitrary<SecretLine> = fc
  .tuple(
    safeWordArbitrary,
    fc.stringMatching(/^[A-Za-z0-9_-]{5,10}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{5,10}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{5,10}$/),
  )
  .map(([name, seg1, seg2, seg3]) => {
    const jwt = `eyJ${seg1}.${seg2}.${seg3}`;
    return {
      line: `const ${name} = "Bearer ${jwt}";`,
      label: SECRET_PATTERN_LABELS.JWT_TOKEN,
      secretValue: jwt,
    };
  });

/** `<keyword><separator> [quote]<value>` (generic credential assignment). */
const genericCredentialLineArbitrary: fc.Arbitrary<SecretLine> = fc
  .tuple(
    fc.constantFrom(
      'api_key', 'apikey', 'access_key', 'secret_key', 'client_secret',
      'token', 'password', 'passwd', 'pwd', 'secret', 'auth_token',
    ),
    fc.constantFrom(':', '='),
    fc.boolean(),
    fc.stringMatching(/^[A-Za-z0-9]{6,12}$/),
  )
  .map(([keyword, separator, quoted, value]) => {
    const secretValue = quoted ? `"${value}"` : value;
    return {
      line: `${keyword}${separator} ${secretValue}`,
      label: SECRET_PATTERN_LABELS.GENERIC_CREDENTIAL,
      secretValue: value,
    };
  });

/** Any one of the four secret-shaped line kinds, uniformly chosen. */
const secretLineArbitrary: fc.Arbitrary<SecretLine> = fc.oneof(
  awsKeyLineArbitrary,
  privateKeyLineArbitrary,
  jwtLineArbitrary,
  genericCredentialLineArbitrary,
);

/** A safe, unique-enough fake file path. */
const filePathArbitrary = safeWordArbitrary.map((name) => `/repo/src/${name}.ts`);

// ---------------------------------------------------------------------------
// SecretDetector properties
// ---------------------------------------------------------------------------

describe('SecretDetector property tests - Property 17: Secret pattern detection', () => {
  it('detects a secret-shaped line embedded at an arbitrary position within otherwise-safe surrounding text', async () => {
    await fc.assert(
      fc.asyncProperty(
        filePathArbitrary,
        safeLinesBlockArbitrary,
        secretLineArbitrary,
        safeLinesBlockArbitrary,
        async (filePath, beforeLines, secret, afterLines) => {
          const content = [...beforeLines, secret.line, ...afterLines].join('\n');
          const expectedLine = beforeLines.length + 1;

          const reader = new FakeFileContentReader({ [filePath]: content });
          const detector = new SecretDetector(reader);

          const findings = await detector.detect([filePath]);

          // The secret must be reported at its exact file + line location.
          expect(findings).toContainEqual({ filePath, line: expectedLine, pattern: secret.label });

          // The matched secret value itself must never appear in the findings.
          if (secret.secretValue) {
            expect(JSON.stringify(findings)).not.toContain(secret.secretValue);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('detects every embedded secret across multiple staged files, each at its own correct location', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(filePathArbitrary, { minLength: 2, maxLength: 4 }),
        fc.array(safeLinesBlockArbitrary, { minLength: 2, maxLength: 4 }),
        fc.array(secretLineArbitrary, { minLength: 2, maxLength: 4 }),
        async (filePaths, beforeLinesPerFile, secretsPerFile) => {
          const count = Math.min(filePaths.length, beforeLinesPerFile.length, secretsPerFile.length);
          const files: Record<string, string> = {};
          const expected: SecretFinding[] = [];

          for (let i = 0; i < count; i++) {
            const filePath = filePaths[i];
            const beforeLines = beforeLinesPerFile[i];
            const secret = secretsPerFile[i];
            const content = [...beforeLines, secret.line].join('\n');
            files[filePath] = content;
            expected.push({ filePath, line: beforeLines.length + 1, pattern: secret.label });
          }

          const reader = new FakeFileContentReader(files);
          const detector = new SecretDetector(reader);

          const findings = await detector.detect(Object.keys(files));

          for (const exp of expected) {
            expect(findings).toContainEqual(exp);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('produces no findings for files containing only safe surrounding text', async () => {
    await fc.assert(
      fc.asyncProperty(filePathArbitrary, safeLinesBlockArbitrary, async (filePath, lines) => {
        const content = lines.join('\n');
        const reader = new FakeFileContentReader({ [filePath]: content });
        const detector = new SecretDetector(reader);

        const findings = await detector.detect([filePath]);

        expect(findings).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// SecretCommitGate properties
// ---------------------------------------------------------------------------

const findingArbitrary: fc.Arbitrary<SecretFinding> = fc
  .tuple(filePathArbitrary, fc.integer({ min: 1, max: 500 }), fc.constantFrom(...Object.values(SECRET_PATTERN_LABELS)))
  .map(([filePath, line, pattern]) => ({ filePath, line, pattern }));

describe('SecretCommitGate property tests - Property 17: presence of any secret triggers commit blocking', () => {
  it('requires explicit confirmation whenever the findings array is non-empty', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(findingArbitrary, { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        async (findings, userAnswer) => {
          const prompt = new FakeConfirmationPrompt(userAnswer);
          const gate = new SecretCommitGate(prompt);

          const result = await gate.evaluate(findings);

          // Any detected secret marks the gate as found and forces the
          // confirmation prompt to be consulted (commit is never allowed
          // to proceed automatically/silently).
          expect(result.secretsFound).toBe(true);
          expect(prompt.calls).toEqual([findings]);
          // proceed must reflect exactly the user's explicit decision.
          expect(result.proceed).toBe(userAnswer);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never blocks and never prompts when there are no findings', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (userAnswer) => {
        const prompt = new FakeConfirmationPrompt(userAnswer);
        const gate = new SecretCommitGate(prompt);

        const result = await gate.evaluate([]);

        expect(result).toEqual({ secretsFound: false, proceed: true });
        expect(prompt.calls.length).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
