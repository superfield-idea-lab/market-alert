import Ajv from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

/**
 * Module-level AJV instance — created once at startup, never per call.
 * allErrors: true collects all validation errors in a single pass.
 */
const ajv = new Ajv({ allErrors: true });

/**
 * Module-level compiled-validator cache keyed by schema object reference.
 *
 * AJV compilation is expensive (regex compilation, schema traversal). By
 * caching the compiled ValidateFunction keyed on the schema object identity,
 * each schema is compiled exactly once at first use and reused on every
 * subsequent call. The public API of validate() is unchanged.
 */
const validatorCache = new WeakMap<object, ValidateFunction>();

export type AjvErrorObject = Pick<
  ErrorObject,
  'instancePath' | 'message' | 'params' | 'keyword' | 'schemaPath'
>;

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; errors: AjvErrorObject[] };

/**
 * Return the cached compiled ValidateFunction for `schema`, compiling on first
 * access. Exported for unit testing only — production code should call validate().
 */
export function getCompiledValidator(schema: object): ValidateFunction {
  let validateFn = validatorCache.get(schema);
  if (!validateFn) {
    validateFn = ajv.compile(schema);
    validatorCache.set(schema, validateFn);
  }
  return validateFn;
}

/**
 * Validate `data` against a JSON Schema using AJV 8.x with `allErrors: true`.
 *
 * The compiled ValidateFunction for `schema` is cached at the module level so
 * AJV compilation occurs once per unique schema object, not once per call.
 *
 * Returns `{valid: true, data: T}` on success or
 * `{valid: false, errors: AjvErrorObject[]}` on failure.
 */
export function validate<T>(schema: object, data: unknown): ValidationResult<T> {
  const validateFn = getCompiledValidator(schema);
  const valid = validateFn(data);

  if (valid) {
    return { valid: true, data: data as T };
  }

  const errors: AjvErrorObject[] = (validateFn.errors ?? []).map((e) => ({
    instancePath: e.instancePath,
    message: e.message ?? 'validation error',
    params: e.params,
    keyword: e.keyword,
    schemaPath: e.schemaPath,
  }));

  return { valid: false, errors };
}
