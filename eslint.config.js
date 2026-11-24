import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'node_modules', 'scripts', 'blender'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The mesh core must stay independent of Three.js, the DOM and the UI so it can be tested
    // on its own and reused (e.g. inside a worker or a Capacitor build).
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*'], message: 'core must not depend on Three.js' },
            { group: ['preact', 'preact/*', '@preact/*'], message: 'core must not depend on the UI' },
            { group: ['**/render/**', '**/input/**', '**/ui/**', '**/app/**'], message: 'core is the bottom layer' },
          ],
        },
      ],
    },
  },
);
