import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.jest,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value=/\\.\\.\\/\\.\\.\\/backend/]",
          message: 'Frontend must not import backend code. Consume backend state via fetch(/api/...) only.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Frontend must not import PostgreSQL.' },
            { name: 'ioredis', message: 'Frontend must not import Redis.' },
            { name: '@octokit/rest', message: 'Frontend must not import GitHub SDK directly.' },
            { name: '@electric-sql/pglite', message: 'Frontend must not import pglite.' },
          ],
          patterns: [
            { group: ['@workflowos/backend/*', '../../backend/*', '../backend/*'], message: 'Frontend must not import backend code.' },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
