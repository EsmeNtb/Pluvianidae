import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SecurityFilter } from '../../src/services/security-filter';

// Feature: pluvianidae-mvp, Property 4: Sensitive file exclusion
//
// "For any file path, the SecurityFilter SHALL exclude it from all analysis
// processes if and only if it matches one of the defined sensitive patterns
// (.env*, *.pem, *.key, *.cert, *.p12, credentials.json, *secret*, .ssh/*,
// .aws/*) or a user-configured custom exclusion pattern."
// Validates: Requirements 1.4, 11.1, 11.2

const NUM_RUNS = 100;

/** Sensitive substrings that would accidentally trigger a default pattern. */
const SENSITIVE_MARKERS = [
  'env',
  'pem',
  'key',
  'cert',
  'p12',
  'pfx',
  'keystore',
  'credentials',
  'secret',
  'ssh',
  'aws',
  'json',
];

function containsSensitiveMarker(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_MARKERS.some((marker) => lower.includes(marker));
}

/** Short lowercase alphanumeric fragment, possibly empty. */
const alnumFragment = fc.stringMatching(/^[a-z0-9]{0,8}$/);

/** Short lowercase path segment (non-empty), safe to use as a directory name. */
const pathSegment = fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/);

/** A filename that is "clearly benign" - never matches any default pattern. */
const benignFilename = fc
  .stringMatching(/^[a-z][a-z0-9]{3,10}\.ts$/)
  .filter((name) => !containsSensitiveMarker(name));

describe('SecurityFilter property tests', () => {
  describe('Property 4: Sensitive file exclusion - default patterns (qualifying examples)', () => {
    it('excludes any filename matching the .env* pattern', () => {
      fc.assert(
        fc.property(alnumFragment, fc.option(pathSegment, { nil: undefined }), (suffix, dir) => {
          const filter = new SecurityFilter();
          const filePath = dir ? `${dir}/.env${suffix}` : `.env${suffix}`;
          expect(filter.shouldExclude(filePath)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('excludes files by sensitive extension (.pem/.key/.cert/.p12/.pfx/.keystore)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('pem', 'key', 'cert', 'p12', 'pfx', 'keystore'),
          pathSegment,
          fc.option(pathSegment, { nil: undefined }),
          (extension, base, dir) => {
            const filter = new SecurityFilter();
            const filePath = dir ? `${dir}/${base}.${extension}` : `${base}.${extension}`;
            expect(filter.shouldExclude(filePath)).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('excludes credentials.json regardless of its containing directory', () => {
      fc.assert(
        fc.property(fc.option(pathSegment, { nil: undefined }), (dir) => {
          const filter = new SecurityFilter();
          const filePath = dir ? `${dir}/credentials.json` : 'credentials.json';
          expect(filter.shouldExclude(filePath)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('excludes any *_credentials.json variant', () => {
      fc.assert(
        fc.property(pathSegment, (prefix) => {
          const filter = new SecurityFilter();
          expect(filter.shouldExclude(`${prefix}_credentials.json`)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('excludes any service-account*.json variant', () => {
      fc.assert(
        fc.property(alnumFragment, (suffix) => {
          const filter = new SecurityFilter();
          expect(filter.shouldExclude(`service-account${suffix}.json`)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('excludes any filename containing "secret" anywhere in its basename', () => {
      fc.assert(
        fc.property(alnumFragment, alnumFragment, (prefix, suffix) => {
          const filter = new SecurityFilter();
          expect(filter.shouldExclude(`${prefix}secret${suffix}.ts`)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('excludes any file located under a .ssh/ directory', () => {
      fc.assert(
        fc.property(fc.option(pathSegment, { nil: undefined }), pathSegment, (outerDir, filename) => {
          const filter = new SecurityFilter();
          const filePath = outerDir ? `${outerDir}/.ssh/${filename}` : `.ssh/${filename}`;
          expect(filter.shouldExclude(filePath)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('excludes any file located under an .aws/ directory', () => {
      fc.assert(
        fc.property(fc.option(pathSegment, { nil: undefined }), pathSegment, (outerDir, filename) => {
          const filter = new SecurityFilter();
          const filePath = outerDir ? `${outerDir}/.aws/${filename}` : `.aws/${filename}`;
          expect(filter.shouldExclude(filePath)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('Property 4: Sensitive file exclusion - clearly benign filenames', () => {
    it('never excludes a clearly benign filename', () => {
      fc.assert(
        fc.property(benignFilename, (filename) => {
          const filter = new SecurityFilter();
          expect(filter.shouldExclude(filename)).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('Property 4: Sensitive file exclusion - user-configured exclusions', () => {
    it('excludes files matching a user-added glob pattern and lists it', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[A-Z][A-Z0-9]{2,8}$/),
          fc.stringMatching(/^[A-Z0-9]{0,8}$/),
          (prefix, suffix) => {
            const filter = new SecurityFilter();
            const pattern = `${prefix}*`;
            const filename = `${prefix}${suffix}.test`;

            filter.addUserExclusion(pattern);

            expect(filter.shouldExclude(filename)).toBe(true);
            expect(filter.getExclusionPatterns()).toContain(pattern);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('Property 4: Sensitive file exclusion - "if and only if" direction', () => {
    it('does not exclude a filename matching neither default patterns nor user exclusions', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[A-Z][A-Z0-9]{2,8}$/),
          benignFilename,
          (userPrefix, filename) => {
            const filter = new SecurityFilter();
            filter.addUserExclusion(`${userPrefix}*`);

            // filename is lowercase and unrelated to the uppercase user
            // pattern, and is already known to be benign against defaults.
            expect(filter.shouldExclude(filename)).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Property 23: Sensitive value redaction
// ---------------------------------------------------------------------------
//
// "For any report content containing tokens, passwords, API keys, or
// connection strings, the Sistema SHALL replace all sensitive values with a
// redaction indicator such that the original value is neither visible nor
// partially reconstructible from the output."
// Validates: Requirements 11.5
//
// The implementation always replaces matches with a FIXED placeholder
// (`REDACTION_INDICATOR`), never partial masking, so asserting the original
// secret value is fully absent from the output is sufficient to cover the
// "not partially reconstructible" requirement here.

import { REDACTION_INDICATOR } from '../../src/services/security-filter';

const secretValueArbitrary = fc.stringMatching(/^[A-Za-z0-9]{8,20}$/);
const base64UrlSegmentArbitrary = fc.stringMatching(/^[A-Za-z0-9_-]{6,15}$/);

describe('SecurityFilter property tests - Property 23: Sensitive value redaction', () => {
  it('redacts generic key=value secret assignments without leaking the original value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('api_key', 'password', 'token', 'secret', 'access_key', 'client_secret'),
        secretValueArbitrary,
        fc.constantFrom('=', ':'),
        fc.boolean(),
        (keyword, secretValue, separator, quoted) => {
          const filter = new SecurityFilter();
          const value = quoted ? `"${secretValue}"` : secretValue;
          const content = `${keyword}${separator} ${value}`;

          const output = filter.redactSensitiveValues(content);

          expect(output).not.toContain(secretValue);
          expect(output).toContain(REDACTION_INDICATOR);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('redacts AWS-style access keys embedded in surrounding text', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9A-Z]{16}$/), (suffix) => {
        const filter = new SecurityFilter();
        const awsKey = `AKIA${suffix}`;
        const content = `AWS key: ${awsKey} in use`;

        const output = filter.redactSensitiveValues(content);

        expect(output).not.toContain(awsKey);
        expect(output).toContain(REDACTION_INDICATOR);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('redacts connection strings without leaking user, password, or host', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('postgres', 'postgresql', 'mysql', 'mongodb', 'redis'),
        fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/),
        secretValueArbitrary,
        fc.stringMatching(/^[a-z][a-z0-9]{2,10}\.example\.com$/),
        (scheme, user, secretValue, host) => {
          const filter = new SecurityFilter();
          const content = `DB_URL=${scheme}://${user}:${secretValue}@${host}:5432/db`;

          const output = filter.redactSensitiveValues(content);

          expect(output).not.toContain(secretValue);
          expect(output).not.toContain(user);
          expect(output).not.toContain(host);
          expect(output).toContain(REDACTION_INDICATOR);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('redacts JWT-like bearer tokens, including ones ending in a hyphen', () => {
    fc.assert(
      fc.property(
        base64UrlSegmentArbitrary,
        base64UrlSegmentArbitrary,
        base64UrlSegmentArbitrary,
        (seg1, seg2, seg3) => {
          const filter = new SecurityFilter();
          const jwt = `eyJ${seg1}.${seg2}.${seg3}`;
          const content = `Authorization: Bearer ${jwt}`;

          const output = filter.redactSensitiveValues(content);

          expect(output).not.toContain(jwt);
          expect(output).toContain(REDACTION_INDICATOR);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('regression: redacts a JWT whose final segment ends in a hyphen (previously unmatched due to a trailing \\b anchor)', () => {
    const filter = new SecurityFilter();
    const jwt = 'eyJaaaaAa._A__a0.A-Aa--';
    const content = `Authorization: Bearer ${jwt}`;

    const output = filter.redactSensitiveValues(content);

    expect(output).not.toContain(jwt);
    expect(output).toContain(REDACTION_INDICATOR);
  });
});
