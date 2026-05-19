// Intentional raw-SQL violation used by `test/no-raw-sql-rule.test.ts`
// to confirm the chokepoint check (#582 / #554 T-9) actually fires.
// This file lives in `packages/db/**` which IS the safelisted root, so
// the production lint script (scripts/check-no-raw-sql.mjs) ignores
// it. The fixture test copies it to a temporary location *outside*
// packages/db, runs the script there, and asserts a non-zero exit.

declare const tx: { $queryRaw: (s: TemplateStringsArray) => Promise<unknown> };

export async function violatingFn(): Promise<unknown> {
  return tx.$queryRaw`select 1`;
}
