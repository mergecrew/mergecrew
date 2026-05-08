export class MergecrewError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
    public httpStatus = 500,
  ) {
    super(message);
    this.name = 'MergecrewError';
  }
}

export class NotFoundError extends MergecrewError {
  constructor(message = 'not found', details?: Record<string, unknown>) {
    super('NOT_FOUND', message, details, 404);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends MergecrewError {
  constructor(message = 'unauthorized') {
    super('UNAUTHORIZED', message, undefined, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends MergecrewError {
  constructor(message = 'forbidden', details?: Record<string, unknown>) {
    super('FORBIDDEN', message, details, 403);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends MergecrewError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, details, 400);
    this.name = 'ValidationError';
  }
}

export class GateRequiredError extends MergecrewError {
  constructor(reason: string, requiredRole?: string) {
    super('GATE_REQUIRED', `gate required: ${reason}`, { reason, requiredRole }, 409);
    this.name = 'GateRequiredError';
  }
}

export class BudgetExhaustedError extends MergecrewError {
  constructor(scope: 'org' | 'project' | 'run' | 'changeset' | 'step') {
    super('BUDGET_EXHAUSTED', `budget exhausted at scope ${scope}`, { scope }, 429);
    this.name = 'BudgetExhaustedError';
  }
}

export class RateLimitedError extends MergecrewError {
  constructor(public retryAfterMs: number, public providerKind?: string) {
    super('RATE_LIMITED', 'rate limited', { retryAfterMs, providerKind }, 429);
    this.name = 'RateLimitedError';
  }
}

export class ProviderUnavailableError extends MergecrewError {
  constructor(public providerKind: string, message = 'provider unavailable') {
    super('PROVIDER_UNAVAILABLE', message, { providerKind }, 502);
    this.name = 'ProviderUnavailableError';
  }
}
