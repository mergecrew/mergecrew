import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalTranscriptStore, transcriptStoreFromEnv } from '../src/index.js';

describe('LocalTranscriptStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSON to disk and returns a file:// URL', async () => {
    const store = new LocalTranscriptStore(dir);
    const url = await store.put('runs/abc/step-1.json', { messages: [{ role: 'user', content: 'hi' }] });
    expect(url).toMatch(/^file:\/\//);
    const path = url.replace(/^file:\/\//, '');
    const body = JSON.parse(readFileSync(path, 'utf8'));
    expect(body.messages[0].content).toBe('hi');
  });

  it('creates intermediate directories', async () => {
    const store = new LocalTranscriptStore(dir);
    const url = await store.put('a/b/c/d/transcript.json', { ok: true });
    expect(url).toContain('/a/b/c/d/transcript.json');
  });
});

describe('transcriptStoreFromEnv', () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it('returns null when neither bucket nor local-dir is set', () => {
    delete process.env.TRANSCRIPT_S3_BUCKET;
    delete process.env.TRANSCRIPT_LOCAL_DIR;
    expect(transcriptStoreFromEnv()).toBeNull();
  });

  it('prefers S3 when both are set', () => {
    process.env.TRANSCRIPT_S3_BUCKET = 'a-bucket';
    process.env.TRANSCRIPT_LOCAL_DIR = '/tmp/foo';
    const s = transcriptStoreFromEnv();
    expect(s?.constructor.name).toBe('S3TranscriptStore');
  });

  it('falls back to local when only local is set', () => {
    delete process.env.TRANSCRIPT_S3_BUCKET;
    process.env.TRANSCRIPT_LOCAL_DIR = '/tmp/foo';
    const s = transcriptStoreFromEnv();
    expect(s?.constructor.name).toBe('LocalTranscriptStore');
  });
});
