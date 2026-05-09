import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { MergecrewError } from '@mergecrew/domain';
import { ZodError } from 'zod';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse();
      const objBody = typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : null;
      // When a guard throws `new ForbiddenException({code, message})`, prefer
      // that explicit code over the generic class-derived one so the
      // frontend can distinguish e.g. MFA_REQUIRED_NOT_ENROLLED from the
      // catch-all FORBIDDEN.
      const explicitCode = objBody && typeof objBody.code === 'string' ? (objBody.code as string) : null;
      res.status(status).json({
        error: {
          code: explicitCode ?? exception.name.replace('Exception', '').toUpperCase(),
          message: typeof r === 'string' ? r : ((objBody?.message as string | undefined) ?? 'error'),
          details: objBody ?? undefined,
        },
      });
      return;
    }

    if (exception instanceof MergecrewError) {
      res.status(exception.httpStatus).json({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
        },
      });
      return;
    }

    if (exception instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'invalid input',
          details: { issues: exception.issues },
        },
      });
      return;
    }

    // eslint-disable-next-line no-console
    console.error('[unhandled]', exception);
    res.status(500).json({
      error: { code: 'INTERNAL', message: 'internal server error' },
    });
  }
}
