import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
// @ts-expect-error - No types available for this deep import
import pluginReactConfig from 'eslint-plugin-react/configs/recommended.js';

// No-direct-env-secret rule — Phase 0 secrets abstraction (issue #11).
//
// All secret reads must route through the `getSecret` / `getSecretOrNull` API
// from `packages/core/secrets.ts`. Direct `process.env` access for the names
// listed in `SecretName` is forbidden in app code so that the secrets backend
// can be swapped (e.g. KMS in Phase 1) without changing callers.
//
// Scope: all app and package source files. The shim itself
// (packages/core/secrets.ts) is exempted via the ignores list.
//
// Canonical doc: docs/implementation-plan-v1.md Phase 0
// Blueprint ref: calypso-blueprint/rules/blueprints/env.yaml

/** Secret-like env-var name pattern (all caps with underscores, KEY/SECRET/TOKEN/PASSWORD suffix). */
const SECRET_ENV_PATTERN =
  '(?:ENCRYPTION_MASTER_KEY|JWT_EC_PRIVATE_KEY(?:_OLD)?|SUBSTACK_API_KEY|BLOOMBERG_API_KEY|YAHOO_API_KEY|[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY))';

const noDirectEnvSecretRule = {
  files: ['apps/**/*.ts', 'packages/**/*.ts', 'packages/**/*.tsx', 'apps/**/*.tsx'],
  ignores: [
    // The shim is the one place allowed to read process.env for secrets
    'packages/core/secrets.ts',
    // Tests may set/unset env vars directly for isolation
    '**/*.test.ts',
    '**/*.test.tsx',
  ],
  rules: {
    'no-restricted-syntax': [
      'warn',
      {
        // process.env.SECRET_NAME (member expression)
        selector: `MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/${SECRET_ENV_PATTERN}/]`,
        message:
          'Direct process.env access for secrets is forbidden. Use getSecret() or getSecretOrNull() from packages/core/secrets.ts. See docs/implementation-plan-v1.md Phase 0.',
      },
      {
        // process.env["SECRET_NAME"] (computed member expression with string literal)
        selector: `MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value=/${SECRET_ENV_PATTERN}/]`,
        message:
          'Direct process.env access for secrets is forbidden. Use getSecret() or getSecretOrNull() from packages/core/secrets.ts. See docs/implementation-plan-v1.md Phase 0.',
      },
    ],
  },
};

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
  // No-direct-env-secret enforcement for app and package source files (Phase 0 secrets)
  noDirectEnvSecretRule,
];
