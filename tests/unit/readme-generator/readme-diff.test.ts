import { describe, it, expect } from 'vitest';
import { computeReadmeDiff } from '../../../src/modules/readme-generator/readme-diff';

describe('computeReadmeDiff', () => {
  it('returns undefined when there is no existing README', () => {
    const diff = computeReadmeDiff(undefined, '# New README\n\nSome content.\n');
    expect(diff).toBeUndefined();
  });

  it('returns a "no changes" result when the content is identical', () => {
    const content = '# README\n\nLine one.\nLine two.\n';
    const diff = computeReadmeDiff(content, content);
    expect(diff).toBe('Sin cambios respecto al README existente.');
  });

  it('shows added lines as additions', () => {
    const existing = 'Line one.\nLine two.\n';
    const draft = 'Line one.\nLine two.\nLine three.\n';

    const diff = computeReadmeDiff(existing, draft);

    expect(diff).toContain('  Line one.');
    expect(diff).toContain('  Line two.');
    expect(diff).toContain('+ Line three.');
    expect(diff).not.toContain('- Line three.');
  });

  it('shows removed lines as removals', () => {
    const existing = 'Line one.\nLine two.\nLine three.\n';
    const draft = 'Line one.\nLine three.\n';

    const diff = computeReadmeDiff(existing, draft);

    expect(diff).toContain('- Line two.');
    expect(diff).toContain('  Line one.');
    expect(diff).toContain('  Line three.');
  });

  it('shows a modified line as a removal followed by an addition', () => {
    const existing = 'Line one.\nOld line two.\nLine three.\n';
    const draft = 'Line one.\nNew line two.\nLine three.\n';

    const diff = computeReadmeDiff(existing, draft);
    const lines = diff!.split('\n');

    const removedIndex = lines.indexOf('- Old line two.');
    const addedIndex = lines.indexOf('+ New line two.');
    expect(removedIndex).toBeGreaterThanOrEqual(0);
    expect(addedIndex).toBeGreaterThanOrEqual(0);
    expect(addedIndex).toBe(removedIndex + 1);
  });

  it('handles an existing empty README against a non-empty draft as a pure addition', () => {
    const diff = computeReadmeDiff('', '# README\n\nContent.\n');

    expect(diff).toContain('+ # README');
    expect(diff).toContain('+ Content.');
    expect(diff).not.toMatch(/^- /m);
  });
});
