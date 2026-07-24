import { describe, it, expect, beforeEach } from 'vitest';
import { SecurityFilter, REDACTION_INDICATOR } from '../../src/services/security-filter';

describe('SecurityFilter', () => {
  let filter: SecurityFilter;

  beforeEach(() => {
    filter = new SecurityFilter();
  });

  describe('shouldExclude - default patterns', () => {
    it('excludes .env and .env-like files', () => {
      expect(filter.shouldExclude('.env')).toBe(true);
      expect(filter.shouldExclude('.env.local')).toBe(true);
      expect(filter.shouldExclude('config/.env.production')).toBe(true);
    });

    it('excludes key/cert/keystore files by extension', () => {
      expect(filter.shouldExclude('server.pem')).toBe(true);
      expect(filter.shouldExclude('private.key')).toBe(true);
      expect(filter.shouldExclude('client.p12')).toBe(true);
      expect(filter.shouldExclude('client.pfx')).toBe(true);
      expect(filter.shouldExclude('app.keystore')).toBe(true);
    });

    it('excludes credentials and service-account json files', () => {
      expect(filter.shouldExclude('credentials.json')).toBe(true);
      expect(filter.shouldExclude('gcp_credentials.json')).toBe(true);
      expect(filter.shouldExclude('service-account-prod.json')).toBe(true);
    });

    it('excludes files containing "secret" anywhere in the name', () => {
      expect(filter.shouldExclude('my-secret-file.txt')).toBe(true);
      expect(filter.shouldExclude('src/config/secrets.ts')).toBe(true);
    });

    it('excludes files under .ssh/ and .aws/ directories', () => {
      expect(filter.shouldExclude('.ssh/id_rsa')).toBe(true);
      expect(filter.shouldExclude('home/user/.aws/credentials')).toBe(true);
      expect(filter.shouldExclude('C:\\Users\\dev\\.ssh\\id_rsa')).toBe(true);
    });

    it('does not exclude ordinary source files', () => {
      expect(filter.shouldExclude('src/index.ts')).toBe(false);
      expect(filter.shouldExclude('README.md')).toBe(false);
      expect(filter.shouldExclude('package.json')).toBe(false);
    });
  });

  describe('user-configured exclusions', () => {
    it('excludes files matching a user-added glob pattern', () => {
      expect(filter.shouldExclude('src/internal/notes.md')).toBe(false);
      filter.addUserExclusion('src/internal/*');
      expect(filter.shouldExclude('src/internal/notes.md')).toBe(true);
    });

    it('lists default and user patterns together', () => {
      filter.addUserExclusion('*.local.json');
      const patterns = filter.getExclusionPatterns();
      expect(patterns).toContain('.env*');
      expect(patterns).toContain('*.local.json');
    });

    it('ignores empty/whitespace-only patterns', () => {
      const before = filter.getExclusionPatterns().length;
      filter.addUserExclusion('   ');
      expect(filter.getExclusionPatterns().length).toBe(before);
    });
  });

  describe('redactSensitiveValues', () => {
    it('redacts generic key=value assignments (api_key, password, token)', () => {
      const input = 'api_key=abcdef123456\npassword: "hunter2"\ntoken = xyz789';
      const output = filter.redactSensitiveValues(input);
      expect(output).not.toContain('abcdef123456');
      expect(output).not.toContain('hunter2');
      expect(output).not.toContain('xyz789');
      expect(output).toContain(REDACTION_INDICATOR);
    });

    it('redacts AWS-style access keys', () => {
      const input = 'AWS key: AKIAIOSFODNN7EXAMPLE in use';
      const output = filter.redactSensitiveValues(input);
      expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(output).toContain(REDACTION_INDICATOR);
    });

    it('redacts connection strings without leaking credentials', () => {
      const input = 'DB_URL=postgres://admin:sup3rSecret@db.example.com:5432/prod';
      const output = filter.redactSensitiveValues(input);
      expect(output).not.toContain('sup3rSecret');
      expect(output).not.toContain('admin');
      expect(output).not.toContain('db.example.com');
      expect(output).toContain(REDACTION_INDICATOR);
    });

    it('redacts JWT-like tokens', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const input = `Authorization header: Bearer ${jwt}`;
      const output = filter.redactSensitiveValues(input);
      expect(output).not.toContain(jwt);
      expect(output).toContain(REDACTION_INDICATOR);
    });

    it('leaves non-sensitive content untouched', () => {
      const input = 'function add(a, b) { return a + b; }';
      expect(filter.redactSensitiveValues(input)).toBe(input);
    });
  });
});
