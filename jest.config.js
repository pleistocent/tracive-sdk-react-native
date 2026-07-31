/**
 * `@react-native/jest-preset` ships an allowlist that does not include `@noble`, and both
 * `@noble/hashes` and `@noble/ciphers` are ESM-only at v2. Without the addition below every
 * suite fails with "Cannot use import statement outside a module", which reads like a broken
 * dependency but is a transform-configuration problem.
 */
export default {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble)/)',
  ],
  testEnvironment: 'node',
  // The preset's default matcher treats every file under `__tests__` as a suite, which picks up
  // shared support modules that contain no tests.
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts',
    // The adapter subpaths statically import optional peer dependencies that this repository
    // deliberately does not install (op-sqlite alone unpacks to ~360 MB). They cannot be loaded
    // in this environment, so a coverage number for them would be a fiction. They are carried
    // as a named risk in docs/OPEN_QUESTIONS.md instead of hidden inside a percentage.
    '!src/expo/**',
    '!src/bare/**',
  ],
  coverageThreshold: {
    global: {
      statements: 80,
    },
    'src/query/**/*.ts': {
      statements: 90,
    },
    'src/cache/**/*.ts': {
      statements: 90,
    },
  },
};
