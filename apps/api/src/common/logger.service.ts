import { Injectable } from '@nestjs/common';
import pino, { type Logger } from 'pino';

@Injectable()
export class LoggerService {
  readonly logger: Logger;
  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      formatters: { level: (l) => ({ level: l }) },
      base: { service: 'api' },
      ...(process.env.NODE_ENV !== 'production'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    });
  }

  info(msg: string, meta?: any) { this.logger.info(meta ?? {}, msg); }
  warn(msg: string, meta?: any) { this.logger.warn(meta ?? {}, msg); }
  error(msg: string, meta?: any) { this.logger.error(meta ?? {}, msg); }
}
