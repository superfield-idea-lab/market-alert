import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
// @ts-expect-error - No types available for this deep import
import pluginReactConfig from 'eslint-plugin-react/configs/recommended.js';

// Zero-mock rule for test files - Phase 0 scaffold (dev-scout).
// CLAUDE.md mandates: No mocks. Zero vi.fn, vi.mock, vi.spyOn, vi.stubGlobal
// in test files. Prefer real dependencies, recorded fixtures, narrow fakes.
// Scope: top-level tests/ directory only (Phase 0 dev-scout).
// apps/ violations are pre-existing tech debt tracked in issue #5.
// Canonical doc: CLAUDE.md Testing Standards
const noMockRule = {
  files: ['tests/**/*.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.object.name='vi'][callee.property.name='fn']",
        message:
          'vi.fn() is banned. Use real dependencies, MSW v2 fixtures, or narrow fakes. See CLAUDE.md Testing Standards.',
      },
      {
        selector: "CallExpression[callee.object.name='vi'][callee.property.name='mock']",
        message:
          'vi.mock() is banned. Use real dependencies, MSW v2 fixtures, or narrow fakes. See CLAUDE.md Testing Standards.',
      },
      {
        selector: "CallExpression[callee.object.name='vi'][callee.property.name='spyOn']",
        message:
          'vi.spyOn() is banned. Use real dependencies, MSW v2 fixtures, or narrow fakes. See CLAUDE.md Testing Standards.',
      },
      {
        selector: "CallExpression[callee.object.name='vi'][callee.property.name='stubGlobal']",
        message:
          'vi.stubGlobal() is banned. Use real dependencies, MSW v2 fixtures, or narrow fakes. See CLAUDE.md Testing Standards.',
      },
    ],
  },
};

export default [
  { ignores: ['**/dist/**', '**/coverage/**', '.agents/**', 'calypso-blueprint/**', 'studio/**'] },
  { files: ['**/*.{js,mjs,cjs,ts,jsx,tsx}'] },
  { languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  { languageOptions: { globals: { ...globals.browser, ...globals.node, Bun: 'readonly' } } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ...pluginReactConfig,
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  // Zero-mock enforcement for top-level tests/ (Phase 0 scaffold)
  noMockRule,
];
