/**
 * API tests: co-located `src/**\/*.spec.ts` plus `test/**\/*.spec.ts`
 * (shared fakes live in test/helpers). Sources use NodeNext-style `.js`
 * suffixes on relative imports; map them back for ts-jest. Workspace
 * packages resolve to their built `dist/` (turbo runs `^build` first).
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
