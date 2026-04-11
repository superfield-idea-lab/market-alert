/**
 * Secrets abstraction layer — Phase 0.
 *
 * All app code resolves secrets through this module. Direct `process.env`
 * access for secret-like names is forbidden outside this file (enforced by
 * the ESLint `no-direct-env-secret` rule in `eslint.config.ts`).
 *
 * ## Backend contract
 *
 * A `SecretsBackend` resolves a named secret to its string value, or throws
 * if the secret is unavailable. Backends are swappable: the dev shim reads
 * from `process.env`; future phases will wire in a KMS backend without
 * changing any call sites.
 *
 * ## Typed secret names
 *
 * `SecretName` is the union of all known secret identifiers. Adding a secret
 * here automatically surfaces it to callers via autocomplete and type-checks.
 *
 * ## Graceful degradation
 *
 * `getSecretOrNull` never throws — it returns `null` when a secret is absent.
 * Use it for optional secrets (feature flags, optional integrations).
 * Use `getSecret` when a secret is required; it throws on absence.
 *
 * Canonical doc: docs/implementation-plan-v1.md Phase 0
 * Blueprint ref: calypso-blueprint/rules/blueprints/env.yaml
 */

// ---------------------------------------------------------------------------
// Typed secret registry
// ---------------------------------------------------------------------------

/**
 * All known secret identifiers.
 *
 * Use screaming-snake-case strings that match the corresponding env-var name
 * used by the dev shim so that `process.env[name]` works in development
 * without any extra mapping.
 *
 * Phase 1 will extend this list with KMS-backed secrets.
 */
export type SecretName =
  | 'ENCRYPTION_MASTER_KEY'
  | 'JWT_EC_PRIVATE_KEY'
  | 'JWT_EC_PRIVATE_KEY_OLD'
  | 'SUBSTACK_API_KEY'
  | 'BLOOMBERG_API_KEY'
  | 'YAHOO_API_KEY';

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * A secrets backend resolves named secrets to string values.
 *
 * Implementations must be synchronous-or-async: the interface returns a
 * `Promise<string>` so async backends (KMS, Vault) are first-class without
 * changing call sites.
 */
export interface SecretsBackend {
  /**
   * Resolves `name` to its secret value.
   * Throws if the secret is absent or the backend cannot reach the store.
   */
  resolve(name: SecretName): Promise<string>;
}

// ---------------------------------------------------------------------------
// Dev env-var shim (default backend)
// ---------------------------------------------------------------------------

/**
 * Dev shim: resolves secrets from `process.env`.
 *
 * This is the only place in the codebase that is permitted to read
 * `process.env` for secret-like names. All other app code must call
 * `getSecret` / `getSecretOrNull` instead.
 *
 * The shim is intentionally thin — no caching, no transformation. It exists
 * solely to satisfy the `SecretsBackend` interface so that the rest of the
 * codebase has no hard dependency on `process.env`.
 */
export class EnvSecretsShim implements SecretsBackend {
  private readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }

  async resolve(name: SecretName): Promise<string> {
    const value = this.env[name];
    if (value === undefined || value === '') {
      throw new Error(
        `Secret "${name}" is not set. ` +
          `In development, add it to your .env file. ` +
          `In production, provision it through the secrets store.`,
      );
    }
    return value;
  }
}

// ---------------------------------------------------------------------------
// Module-level backend registry
// ---------------------------------------------------------------------------

/** Active backend. Defaults to the dev env shim at module load. */
let _backend: SecretsBackend = new EnvSecretsShim();

/**
 * Replaces the active secrets backend.
 *
 * Call this once at server startup to wire in a production backend:
 *
 * ```ts
 * import { configureSecretsBackend } from 'core/secrets';
 * configureSecretsBackend(new KmsSecretsBackend(kmsClient));
 * ```
 *
 * Swapping the backend has no effect on call sites — they always go through
 * `getSecret` / `getSecretOrNull` which read `_backend` at call time.
 */
export function configureSecretsBackend(backend: SecretsBackend): void {
  _backend = backend;
}

/**
 * Returns the currently active backend.
 * Intended for tests that need to inspect or reset the backend.
 */
export function getSecretsBackend(): SecretsBackend {
  return _backend;
}

/**
 * Resets the backend to the default dev env shim.
 * Intended for test isolation between suites.
 */
export function _resetSecretsBackend(): void {
  _backend = new EnvSecretsShim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves a named secret through the active backend.
 *
 * Throws if the secret is absent. Use this for required secrets.
 *
 * @example
 * ```ts
 * const key = await getSecret('ENCRYPTION_MASTER_KEY');
 * ```
 */
export async function getSecret(name: SecretName): Promise<string> {
  return _backend.resolve(name);
}

/**
 * Resolves a named secret through the active backend.
 *
 * Returns `null` if the secret is absent (backend throws). Use this for
 * optional secrets (feature flags, optional integrations).
 *
 * @example
 * ```ts
 * const apiKey = await getSecretOrNull('SUBSTACK_API_KEY');
 * if (apiKey) { ... }
 * ```
 */
export async function getSecretOrNull(name: SecretName): Promise<string | null> {
  try {
    return await _backend.resolve(name);
  } catch {
    return null;
  }
}
