import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'lib/**',
      'coverage/**',
      'node_modules/**',
      'example/**',
      'android/**',
      'ios/**',
      '*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Codegen reads `Object` as a native map; a Record type would not parse.
    files: ['src/specs/**/*.ts'],
    rules: { '@typescript-eslint/no-wrapper-object-types': 'off' },
  },
  {
    files: ['src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-wrapper-object-types': 'off',
      'no-console': 'off',
    },
  },
  {
    // A TextEncoder here passes every test on Node and crashes on device.
    files: ['src/**/*.ts'],
    ignores: ['src/expo/**/*.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'TextEncoder', message: 'Hermes has no TextEncoder.' },
        { name: 'TextDecoder', message: 'Hermes has no TextDecoder.' },
        { name: 'Buffer', message: 'Buffer only exists in React Native by accident.' },
        { name: 'btoa', message: 'Use base64Encode from src/base64.ts.' },
        { name: 'atob', message: 'Nothing here decodes base64 in JavaScript.' },
      ],
    },
  },
);
