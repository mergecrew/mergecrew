import 'reflect-metadata';
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { buildOpenApiDocumentConfig } from './openapi-config.js';

/**
 * Boots the Nest app graph (no listen) and writes the OpenAPI JSON to
 * docs/openapi.json so SDK generators and external API consumers can pick
 * up the spec without spinning up the full API. Runs in CI to detect drift.
 */
async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  const doc = SwaggerModule.createDocument(app, buildOpenApiDocumentConfig());

  // tsx executes from apps/api/src; the repo root is three levels up.
  const repoRoot = resolve(__dirname, '../../..');
  const outPath = resolve(repoRoot, 'docs/openapi.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  await app.close();
  console.log(`[openapi-export] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[openapi-export] failed', err);
  process.exit(1);
});
