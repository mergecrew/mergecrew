/**
 * Lock the OpenAI tool-name compatibility shim. OpenAI rejects
 * `function.name` outside `^[a-zA-Z0-9_-]+$`, which historically broke
 * the first run for every org that wired an OpenAI provider against our
 * dotted skill namespace.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeToolName } from '../src/loop.js';

describe('sanitizeToolName', () => {
  it('rewrites dots to underscores so OpenAI accepts the name', () => {
    expect(sanitizeToolName('repo.read_file')).toBe('repo_read_file');
    expect(sanitizeToolName('repo.git.commit')).toBe('repo_git_commit');
    expect(sanitizeToolName('slack.post')).toBe('slack_post');
  });

  it('preserves already-valid names verbatim', () => {
    expect(sanitizeToolName('plain_name')).toBe('plain_name');
    expect(sanitizeToolName('with-dash')).toBe('with-dash');
    expect(sanitizeToolName('mix3d_123')).toBe('mix3d_123');
  });

  it('replaces any other invalid character with underscore', () => {
    expect(sanitizeToolName('foo:bar')).toBe('foo_bar');
    expect(sanitizeToolName('foo bar')).toBe('foo_bar');
    expect(sanitizeToolName('foo/bar')).toBe('foo_bar');
  });

  it('produces wire names that match the OpenAI pattern', () => {
    const pattern = /^[a-zA-Z0-9_-]+$/;
    for (const name of ['repo.read_file', 'build.run_unit_tests', 'memory.recall', 'tracker.list_issues']) {
      expect(sanitizeToolName(name)).toMatch(pattern);
    }
  });
});
