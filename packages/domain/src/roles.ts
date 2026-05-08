import { z } from 'zod';

export const OrgRole = z.enum(['owner', 'admin', 'operator', 'viewer']);
export type OrgRole = z.infer<typeof OrgRole>;

export const ROLE_RANK: Record<OrgRole, number> = {
  owner: 4,
  admin: 3,
  operator: 2,
  viewer: 1,
};

export function roleAtLeast(have: OrgRole, need: OrgRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}
