import { RequestMethod, type MiddlewareConsumer } from '@nestjs/common';
import express from 'express';

export const WEBHOOK_ROUTES = 'v1/webhooks/*path';

/**
 * Body parsing. Webhook routes (every method) get the untouched raw body
 * as a Buffer so providers' HMAC signatures can be verified over the
 * exact bytes; everything else gets the JSON parser. The exclusion must
 * cover RequestMethod.ALL — excluding only GET let the JSON parser eat
 * POST bodies, so no `application/json` webhook could ever verify.
 */
export function applyBodyParsers(consumer: MiddlewareConsumer): void {
  consumer
    .apply(express.json({ limit: '5mb' }))
    .exclude({ path: WEBHOOK_ROUTES, method: RequestMethod.ALL })
    .forRoutes('*');
  consumer
    .apply(express.raw({ type: () => true, limit: '5mb' }))
    .forRoutes({ path: WEBHOOK_ROUTES, method: RequestMethod.ALL });
}
