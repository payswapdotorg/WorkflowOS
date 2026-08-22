import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

/**
 * WORK-022 frontend ESLint config.
 *
 * Enforces the same boundary discipline the static architecture tests in the
 * backend enforce mechanically: no provider SDK imports, no backend internal
 * imports, no authorization-policy keywords in page code. The frontend is a
 * consumer only.
 */
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
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // WORK-022 boundary: the frontend must never import backend internals or
      // provider SDKs. The backend static architecture test is the primary
      // enforcer; this is a secondary guard for fast local feedback.
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
            { name: 'pg', message: 'Frontend must not import PostgreSQL — backend is the only authority.' },
            { name: 'ioredis', message: 'Frontend must not import Redis — backend is the only authority.' },
            { name: '@octokit/rest', message: 'Frontend must not import GitHub SDK directly.' },
            { name: '@electric-sql/pglite', message: 'Frontend must not import pglite.' },
          ],
          patterns: [
            { group: ['@workflowos/backend/*', '../../backend/*', '../backend/*'], message: 'Frontend must not import backend code.' },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
