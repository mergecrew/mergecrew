import type { ModelCapability, ProviderKind } from '@mergecrew/domain';
import type { AwsProviderCredentials, ProviderConfig } from './models.js';

/**
 * Stored-credential encoding for LLM providers.
 *
 * `llm_providers.credential_ciphertext` holds one envelope-encrypted
 * string (see the KMS helpers in the API / runner):
 *
 *  - anthropic / openai / ollama: the raw API key.
 *  - bedrock: a JSON document `{ v: 1, type: 'aws-static', accessKeyId,
 *    secretAccessKey, sessionToken?, region }`. Region lives inside the
 *    blob so there is a single source of truth per provider and no
 *    fallback to the deployment's `AWS_REGION`.
 *
 * Rows from before per-provider Bedrock credentials existed carry either
 * nothing or an unused "API key" string; they decode to no credentials
 * and the provider fails closed until an admin re-enters them.
 */

export interface BedrockCredentialInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

interface BedrockCredentialBlob extends BedrockCredentialInput {
  v: 1;
  type: 'aws-static';
}

const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const AWS_ACCESS_KEY_ID_RE = /^[A-Z0-9]{16,128}$/;

export function isValidAwsRegion(region: string): boolean {
  return AWS_REGION_RE.test(region);
}

/**
 * Validate and serialise Bedrock credentials for encryption. Throws a
 * plain `Error` with a user-displayable message on invalid input.
 */
export function encodeBedrockCredential(input: Partial<BedrockCredentialInput>): string {
  const accessKeyId = (input.accessKeyId ?? '').trim();
  const secretAccessKey = (input.secretAccessKey ?? '').trim();
  const region = (input.region ?? '').trim();
  const sessionToken = (input.sessionToken ?? '').trim();
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error('Bedrock providers require an AWS access key ID, secret access key and region.');
  }
  if (!AWS_ACCESS_KEY_ID_RE.test(accessKeyId)) throw new Error('AWS access key ID is not valid.');
  if (secretAccessKey.length < 16 || secretAccessKey.length > 256 || /\s/.test(secretAccessKey)) {
    throw new Error('AWS secret access key is not valid.');
  }
  if (!isValidAwsRegion(region)) throw new Error('AWS region is not valid (e.g. us-east-1).');
  if (sessionToken.length > 4096) throw new Error('AWS session token is not valid.');
  const blob: BedrockCredentialBlob = {
    v: 1,
    type: 'aws-static',
    accessKeyId,
    secretAccessKey,
    region,
    ...(sessionToken ? { sessionToken } : {}),
  };
  return JSON.stringify(blob);
}

/** Decode a decrypted Bedrock credential; returns null when absent or malformed. */
export function decodeBedrockCredential(
  plaintext: string | null | undefined,
): { region: string; credentials: AwsProviderCredentials } | null {
  if (!plaintext) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  const b = parsed as Partial<BedrockCredentialBlob> | null;
  if (
    !b ||
    b.type !== 'aws-static' ||
    typeof b.accessKeyId !== 'string' ||
    typeof b.secretAccessKey !== 'string' ||
    typeof b.region !== 'string' ||
    !b.accessKeyId ||
    !b.secretAccessKey ||
    !isValidAwsRegion(b.region)
  ) {
    return null;
  }
  return {
    region: b.region,
    credentials: {
      accessKeyId: b.accessKeyId,
      secretAccessKey: b.secretAccessKey,
      ...(typeof b.sessionToken === 'string' && b.sessionToken ? { sessionToken: b.sessionToken } : {}),
    },
  };
}

export interface LlmProviderRowLike<B> {
  id: string;
  kind: string;
  endpoint: string | null;
  credentialCiphertext: B | null;
  capabilityOverrides: unknown;
}

/**
 * Build a `ProviderConfig` from a stored `llm_providers` row. Shared by
 * the API (test/probe), the runner and the eval runner so they all
 * decode credentials the same way — in particular so none of them
 * substitutes deployment-level AWS settings for a tenant's Bedrock
 * provider.
 */
export function providerConfigFromRow<B>(
  row: LlmProviderRowLike<B>,
  decrypt: (blob: B) => string,
): ProviderConfig {
  const overrides = (row.capabilityOverrides ?? null) as Record<string, unknown> | null;
  const models = Array.isArray(overrides?.models) ? (overrides!.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
  const base: ProviderConfig = {
    id: row.id,
    kind: row.kind as ProviderKind,
    endpoint: row.endpoint ?? undefined,
    models,
    capabilityOverrides: (overrides ?? undefined) as Record<string, ModelCapability> | undefined,
  };
  const plaintext = row.credentialCiphertext ? decrypt(row.credentialCiphertext) : undefined;
  if (row.kind === 'bedrock') {
    const aws = decodeBedrockCredential(plaintext);
    if (aws) {
      base.awsRegion = aws.region;
      base.awsCredentials = aws.credentials;
    }
    return base;
  }
  if (plaintext) base.apiKey = plaintext;
  return base;
}
