import { defineConfig } from 'vitest/config';

/**
 * Orchestrator tests are integration tests against a real Redis +
 * Postgres. Several of them share the same BullMQ queue
 * (`runner.step.instance`) and pollute each other's view if vitest
 * runs files in parallel — this is the known flake tracked in
 * commit 650d88d (job-id snapshot vs count) and re-observed in CI
 * for #783.
 *
 * The id-set diff guard partially fixed the flake but doesn't catch
 * the case where a sibling test file is actively consuming the queue
 * during another file's tick. The clean fix is to **serialize test
 * files** so only one orchestrator integration test runs at a time.
 *
 * Slight cost: total wall time goes up (worth it — the orchestrator
 * suite is small and finishes in ~10s either way). All other test
 * suites (sandbox-driver, runner-agent, runner, etc.) keep their
 * default parallel runner because they don't share external state.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
