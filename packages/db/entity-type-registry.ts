/**
 * @file entity-type-registry
 *
 * Property graph entity-type registry.
 *
 * ## Invariant: entity types are data, not schema
 *
 * Adding a new entity type to the system requires an INSERT into the
 * `entity_types` table, never a DDL migration. This module is the sole
 * insertion path for entity types, enforcing that invariant in code.
 *
 * The `entity_types` table is defined in `packages/db/schema.sql`:
 *
 *   CREATE TABLE entity_types (
 *     type        TEXT PRIMARY KEY,
 *     schema      JSONB NOT NULL,          -- JSON Schema for properties validation
 *     sensitive   TEXT[] DEFAULT '{}',     -- property keys that must be encrypted
 *     kms_key_id  TEXT                     -- KMS key that protects sensitive fields
 *   );
 *
 * Entities reference their type via a FK to `entity_types.type`. Inserting a
 * row into `entity_types` is sufficient to make a new entity type legal — no
 * ALTER TABLE, CREATE TABLE, or CREATE INDEX is ever needed.
 *
 * ## Design
 *
 * The registry is a plain in-process Map that acts as a write-through cache.
 * On registration the entry is persisted to `entity_types` via an idempotent
 * UPSERT (ON CONFLICT DO NOTHING). The in-memory copy is always consistent
 * with what was successfully written to the database.
 *
 * ## Canonical docs
 *
 * - `docs/technical/db-architecture.md` §"Why Property Graph"
 * - `docs/implementation-plan-v1.md` §Phase 0
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/7
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Internal type alias so this file does not import from packages/db/index.ts
// (which creates a pool at module load time).
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A JSON Schema object (draft-07 compatible) describing the shape of an
 * entity type's `properties` JSONB column.
 *
 * An empty object `{}` is valid and disables schema validation for that type.
 */
export type EntityPropertySchema = Record<string, unknown>;

/**
 * Definition for a new entity type.
 *
 * `type`       — canonical string identifier; lowercase, underscore-separated
 *                by convention (e.g. `"wiki_page"`, `"corpus_chunk"`).
 *
 * `schema`     — JSON Schema for the `properties` JSONB column.
 *                Pass `{}` to allow any shape (validation deferred to the
 *                application layer).
 *
 * `sensitive`  — optional list of `properties` keys whose values must be
 *                field-encrypted before insertion. Defaults to `[]`.
 *
 * `kmsKeyId`   — optional KMS key identifier used to encrypt `sensitive`
 *                fields. Required when `sensitive` is non-empty in production.
 */
export interface EntityTypeDefinition {
  type: string;
  schema: EntityPropertySchema;
  sensitive?: string[];
  kmsKeyId?: string;
}

/**
 * A registered entity type entry as stored in the in-memory registry.
 * All fields are present and normalised (sensitive defaults to `[]`).
 */
export interface RegisteredEntityType {
  type: string;
  schema: EntityPropertySchema;
  sensitive: string[];
  kmsKeyId: string | null;
}

// ---------------------------------------------------------------------------
// Registry class
// ---------------------------------------------------------------------------

/**
 * EntityTypeRegistry holds the set of registered entity types and provides
 * the sole in-process insertion path for new types.
 *
 * Usage without a database (unit tests, CLI tools):
 *
 *   const registry = new EntityTypeRegistry();
 *   registry.register({ type: 'widget', schema: {} });
 *   registry.get('widget'); // → RegisteredEntityType
 *
 * Usage with a database (server startup):
 *
 *   const registry = new EntityTypeRegistry();
 *   await registry.registerWithDb(sql, { type: 'widget', schema: {} });
 *
 * The two methods are intentionally separate so tests that do not need a live
 * database can exercise the registry without one.
 */
export class EntityTypeRegistry {
  readonly #entries: Map<string, RegisteredEntityType> = new Map();

  // -------------------------------------------------------------------------
  // In-memory registration (no database required)
  // -------------------------------------------------------------------------

  /**
   * Registers an entity type in the in-memory registry.
   *
   * Idempotent: registering the same `type` twice is a no-op (the second
   * call is silently ignored). This mirrors the ON CONFLICT DO NOTHING
   * behaviour of the database insertion path.
   *
   * @throws {TypeError} if `type` is an empty string.
   * @throws {TypeError} if `type` contains characters other than
   *   lowercase letters, digits, and underscores.
   */
  register(definition: EntityTypeDefinition): RegisteredEntityType {
    const { type, schema, sensitive = [], kmsKeyId = null } = definition;

    if (!type) {
      throw new TypeError('EntityTypeDefinition.type must be a non-empty string');
    }

    if (!/^[a-z][a-z0-9_]*$/.test(type)) {
      throw new TypeError(
        `EntityTypeDefinition.type must match /^[a-z][a-z0-9_]*$/: received "${type}"`,
      );
    }

    if (this.#entries.has(type)) {
      return this.#entries.get(type)!;
    }

    const entry: RegisteredEntityType = {
      type,
      schema,
      sensitive,
      kmsKeyId,
    };

    this.#entries.set(type, entry);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Database insertion path
  // -------------------------------------------------------------------------

  /**
   * Registers an entity type in the in-memory registry **and** persists it
   * to the `entity_types` table using an idempotent UPSERT.
   *
   * The database operation is `INSERT … ON CONFLICT DO NOTHING`, so calling
   * this function for a type that was seeded in `schema.sql` (e.g. `"user"`)
   * is safe — no DDL is executed, no schema migration is required.
   *
   * @param sql   — a live postgres.Sql client (from `packages/db/index.ts`)
   * @param definition — the entity type to register
   */
  async registerWithDb(
    sql: SqlClient,
    definition: EntityTypeDefinition,
  ): Promise<RegisteredEntityType> {
    const entry = this.register(definition);

    await sql`
      INSERT INTO entity_types (type, schema, sensitive, kms_key_id)
      VALUES (
        ${entry.type},
        ${sql.json(entry.schema as never)},
        ${entry.sensitive},
        ${entry.kmsKeyId}
      )
      ON CONFLICT (type) DO NOTHING
    `;

    return entry;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Returns the registered entry for `type`, or `undefined` if the type
   * has not been registered in this registry instance.
   */
  get(type: string): RegisteredEntityType | undefined {
    return this.#entries.get(type);
  }

  /**
   * Returns `true` if `type` has been registered.
   */
  has(type: string): boolean {
    return this.#entries.has(type);
  }

  /**
   * Returns all registered entity types as an array, sorted by `type`.
   */
  list(): RegisteredEntityType[] {
    return [...this.#entries.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  /**
   * Returns the number of registered entity types.
   */
  get size(): number {
    return this.#entries.size;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * The module-level singleton registry.
 *
 * Server code should register all application entity types against this
 * singleton at startup, before the first request is handled.
 *
 * Tests that need an isolated registry should instantiate
 * `new EntityTypeRegistry()` directly.
 */
export const entityTypeRegistry = new EntityTypeRegistry();
