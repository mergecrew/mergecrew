import { z } from 'zod';

export const GateReason = z.enum([
  'production_promote',
  'sensitive_path',
  'auth_path',
  'billing_path',
  'migration',
  'major_dep_bump',
  'budget_exhausted',
  'manual_intervention',
]);
export type GateReason = z.infer<typeof GateReason>;

export const GateDecision = z.enum(['approve', 'reject', 'takeover']);
export type GateDecision = z.infer<typeof GateDecision>;

export interface GateEvaluationResult {
  ok: boolean;
  reason?: GateReason;
  details?: Record<string, unknown>;
  requiredRole?: 'operator' | 'admin' | 'owner';
}
