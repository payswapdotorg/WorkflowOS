// WorkflowOS backend — minimal ESLint config (flat config).
// Enforces TypeScript strictness and basic quality rules. The architectural
// boundary enforcement lives in tests/architecture/static-architecture.test.ts
// (PLAT-AC-01 / PLAT-AC-02).
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Config files (vitest.config.ts, eslint.config.js) are not part of the
    // tsconfig project; lint them without parserOptions.project.
    files: ['*.config.ts', '*.config.js', 'eslint.config.js'],
    languageOptions: {
      parser: tsparser,
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
