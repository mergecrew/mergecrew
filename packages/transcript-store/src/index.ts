import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export interface TranscriptStore {
  /**
   * Persist a JSON-serializable transcript. Returns a scheme-prefixed
   * location (`s3://...`, `file://...`) suitable for stamping on
   * AgentStep.transcriptUrl. Throws on real failures (network, fs);
   * the runner wraps the call so a single bad write doesn't kill a step.
   */
  put(key: string, value: unknown): Promise<string>;
}

/**
 * S3-backed transcript store. Honors `S3_ENDPOINT_URL` so MinIO and
 * LocalStack work without further config. `forcePathStyle` is required
 * for those.
 */
export class S3TranscriptStore implements TranscriptStore {
  private client: S3Client;
  constructor(
    private bucket: string,
    opts: { region?: string; endpoint?: string } = {},
  ) {
    this.client = new S3Client({
      region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1',
      ...(opts.endpoint
        ? { endpoint: opts.endpoint, forcePathStyle: true }
        : process.env.S3_ENDPOINT_URL
          ? { endpoint: process.env.S3_ENDPOINT_URL, forcePathStyle: true }
          : {}),
    });
  }

  async put(key: string, value: unknown): Promise<string> {
    const body = JSON.stringify(value);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
      }),
    );
    return `s3://${this.bucket}/${key}`;
  }
}

/**
 * Filesystem fallback. Written under `dir`; the returned URL is
 * `file://<absolute path>`.
 */
export class LocalTranscriptStore implements TranscriptStore {
  constructor(private dir: string) {}

  async put(key: string, value: unknown): Promise<string> {
    const root = isAbsolute(this.dir) ? this.dir : resolve(process.cwd(), this.dir);
    const path = resolve(root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value), 'utf8');
    return `file://${path}`;
  }
}

/**
 * Pick the right store from environment variables. Order:
 *   1. TRANSCRIPT_S3_BUCKET → S3 (works against AWS, MinIO, LocalStack
 *      via S3_ENDPOINT_URL)
 *   2. TRANSCRIPT_LOCAL_DIR → filesystem
 *   3. neither → null (caller skips persistence)
 */
export function transcriptStoreFromEnv(): TranscriptStore | null {
  const bucket = process.env.TRANSCRIPT_S3_BUCKET;
  if (bucket) return new S3TranscriptStore(bucket);
  const localDir = process.env.TRANSCRIPT_LOCAL_DIR;
  if (localDir) return new LocalTranscriptStore(localDir);
  return null;
}
