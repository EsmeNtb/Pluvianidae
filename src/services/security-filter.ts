/**
 * Security Filter service.
 *
 * Filters sensitive files out of analysis and redacts sensitive values from
 * generated reports. See design.md > "13. Security Filter
 * (`services/security-filter.ts`)" and requirements.md > "Requirement 11:
 * Seguridad y privacidad".
 */

export interface ISecurityFilter {
  /** Returns true when the given file path matches a sensitive/exclusion pattern. */
  shouldExclude(filePath: string): boolean;
  /** Returns the full list of active exclusion patterns (default + user-configured). */
  getExclusionPatterns(): string[];
  /** Adds a user-configured glob exclusion pattern. */
  addUserExclusion(pattern: string): void;
  /** Replaces sensitive values (tokens, passwords, API keys, connection strings) with a redaction indicator. */
  redactSensitiveValues(content: string): string;
}

/**
 * Default sensitive file patterns excluded from all analysis, per
 * requirements.md 11.1 and design.md section 13.
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  '*.cert',
  '*.p12',
  '*.pfx',
  '*.keystore',
  'credentials.json',
  '*_credentials.json',
  'service-account*.json',
  '*secret*',
  '.ssh/*',
  '.aws/*',
];

/** Fixed placeholder used to redact sensitive values. Never a partial mask. */
export const REDACTION_INDICATOR = '[REDACTED]';

// ---------------------------------------------------------------------------
// Glob matching helpers
// ---------------------------------------------------------------------------

/**
 * Converts a (non-anchored) glob fragment into an equivalent regex source
 * string. Supports `*` (any run of characters except `/`), `**` (any run of
 * characters including `/`), and `?` (single character except `/`). All
 * other regex metacharacters are escaped literally.
 */
function globFragmentToRegexSource(pattern: string): string {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++; // consume the second '*'
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      source += '\\' + char;
    } else {
      source += char;
    }
  }
  return source;
}

/**
 * Builds a matcher for a single glob pattern.
 *
 * - Patterns without a `/` are matched against the file's base name only
 *   (e.g. `*secret*` matches `my-secret-file.txt` regardless of its folder).
 * - Patterns with a `/` are matched against a path boundary anywhere in the
 *   normalized path (e.g. `.ssh/*` matches `project/.ssh/id_rsa`).
 */
function buildPatternMatcher(pattern: string): (normalizedPath: string, baseName: string) => boolean {
  const fragmentSource = globFragmentToRegexSource(pattern);

  if (pattern.includes('/')) {
    const regex = new RegExp('(^|/)' + fragmentSource + '$');
    return (normalizedPath: string) => regex.test(normalizedPath);
  }

  const regex = new RegExp('^' + fragmentSource + '$');
  return (_normalizedPath: string, baseName: string) => regex.test(baseName);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/** AWS-style access key IDs, e.g. AKIAIOSFODNN7EXAMPLE. */
const AWS_KEY_REGEX = /\bAKIA[0-9A-Z]{16}\b/g;

/** JWT-like tokens: three base64url segments separated by dots. */
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

/** Connection strings such as postgres://user:pass@host, mongodb+srv://..., etc. */
const CONNECTION_STRING_REGEX =
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^\s'"]+/gi;

/**
 * Generic `key = value` / `key: value` secret assignments, e.g.
 * `api_key=abc123`, `password: "hunter2"`, `token = 'xyz'`.
 */
const GENERIC_SECRET_ASSIGNMENT_REGEX =
  /\b((?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|token|password|passwd|pwd|secret|auth[_-]?token)\s*[:=]\s*)(['"]?)([^\s'",;]+)\2/gi;

function redactConnectionStrings(content: string): string {
  return content.replace(CONNECTION_STRING_REGEX, (match, scheme: string) => {
    return `${scheme}://${REDACTION_INDICATOR}`;
  });
}

function redactAwsKeys(content: string): string {
  return content.replace(AWS_KEY_REGEX, REDACTION_INDICATOR);
}

function redactJwtTokens(content: string): string {
  return content.replace(JWT_REGEX, REDACTION_INDICATOR);
}

function redactGenericAssignments(content: string): string {
  return content.replace(
    GENERIC_SECRET_ASSIGNMENT_REGEX,
    (_match, prefix: string) => `${prefix}${REDACTION_INDICATOR}`,
  );
}

// ---------------------------------------------------------------------------
// SecurityFilter implementation
// ---------------------------------------------------------------------------

export class SecurityFilter implements ISecurityFilter {
  private readonly userExclusions: string[] = [];

  shouldExclude(filePath: string): boolean {
    const normalizedPath = normalizePath(filePath);
    const baseName = normalizedPath.split('/').pop() ?? normalizedPath;

    return this.getExclusionPatterns().some((pattern) => {
      const matcher = buildPatternMatcher(pattern);
      return matcher(normalizedPath, baseName);
    });
  }

  getExclusionPatterns(): string[] {
    return [...DEFAULT_SENSITIVE_PATTERNS, ...this.userExclusions];
  }

  addUserExclusion(pattern: string): void {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (!this.userExclusions.includes(trimmed)) {
      this.userExclusions.push(trimmed);
    }
  }

  redactSensitiveValues(content: string): string {
    let redacted = content;
    redacted = redactConnectionStrings(redacted);
    redacted = redactAwsKeys(redacted);
    redacted = redactJwtTokens(redacted);
    redacted = redactGenericAssignments(redacted);
    return redacted;
  }
}
