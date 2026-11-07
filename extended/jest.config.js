export default {
  preset: '@react-native/jest-preset',
  // The base SDK and @noble (which it imports) are ESM-only.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble|@pleistocent/tracive-sdk-react-native)/)',
  ],
  testEnvironment: 'node',
  testMatch: ['**/src/__tests__/**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/example', '<rootDir>/lib'],
};
