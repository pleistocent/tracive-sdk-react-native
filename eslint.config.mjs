import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Older Hermes builds lack these, and the failure mode is a runtime crash on exactly the devices
 * least likely to be in anybody's test matrix.
 */
const HERMES_API_BANS = [
  {
    selector: "MemberExpression[property.name='at'][computed=false]",
    message: 'Array.prototype.at is missing on older Hermes. Use index arithmetic.',
  },
  {
    selector: "MemberExpression[property.name='findLast'][computed=false]",
    message: 'Array.prototype.findLast is missing on older Hermes.',
  },
  {
    selector: "MemberExpression[object.name='Object'][property.name='groupBy'][computed=false]",
    message: 'Object.groupBy is missing on older Hermes.',
  },
];

/**
 * The rules that matter here are the four bans at the bottom. Everything above them is ordinary
 * hygiene; those four encode findings that cost real money if they regress, and `--max-warnings 0`
 * is what makes them fatal rather than advisory.
 */
export default tseslint.config(
  {
    ignores: [
      'lib/**',
      'coverage/**',
      'node_modules/**',
      // The shared grammar fixture is byte-identical across the Tracive SDKs and pinned by hash.
      'test/fixtures/**',
      'example/**',
      // Gradle and Xcode output of the native module, e.g. the HTML test report's scripts.
      'android/build/**',
      'ios/build/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
    },
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
    // Node programs: the build-time doctor, the repository scripts and the CLI entry point.
    // These legitimately use Node globals and print to a terminal.
    files: ['src/doctor/**/*.ts', 'scripts/**/*.js', 'bin/**/*.js', '*.cjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // ------------------------------------------------------------------------------------
    // The bans.
    // ------------------------------------------------------------------------------------
    files: ['src/**/*.ts'],
    ignores: ['src/doctor/**/*.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'TextEncoder',
          message:
            'Hermes has no TextEncoder. Use utf8Encode from src/crypto/utf8.ts — a TextEncoder ' +
            'here passes every test on Node and crashes on device.',
        },
        {
          name: 'TextDecoder',
          message: 'Hermes has no TextDecoder. Use utf8Decode from src/crypto/utf8.ts.',
        },
        {
          name: 'Buffer',
          message: 'Buffer is a Node global that only exists in React Native by accident.',
        },
        {
          name: 'btoa',
          message: 'Use base64UrlEncode from src/crypto/base64url.ts.',
        },
        {
          name: 'atob',
          message: 'Use base64UrlDecode from src/crypto/base64url.ts.',
        },
      ],
      'no-restricted-syntax': ['error', ...HERMES_API_BANS],
    },
  },
  {
    // The fold must never become locale-sensitive. `uppercase(Locale.getDefault())` under the
    // Turkish locale is the exact bug the sibling SDKs had to design around; the JavaScript
    // equivalents are these three, and one of them in this directory changes every key.
    files: ['src/query/**/*.ts'],
    ignores: ['src/query/**/__tests__/**'],
    rules: {
      // ESLint replaces rule options rather than merging them, so the Hermes-API bans are
      // repeated here. Without that, every file in this directory would silently lose them.
      'no-restricted-syntax': [
        'error',
        ...HERMES_API_BANS,
        {
          selector: "MemberExpression[property.name='toLocaleLowerCase']",
          message:
            'Locale-sensitive case mapping changes the folded key under the Turkish locale. ' +
            'Use toLowerCase().',
        },
        {
          selector: "MemberExpression[property.name='toLocaleUpperCase']",
          message:
            'Locale-sensitive case mapping changes the folded key under the Turkish locale. ' +
            'Use toUpperCase().',
        },
        {
          selector: "MemberExpression[property.name='localeCompare']",
          message: 'localeCompare is locale-sensitive and has no place in the fold.',
        },
      ],
    },
  },
);
