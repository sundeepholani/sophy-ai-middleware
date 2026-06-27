/**
 * Make a key's stored output schema portable across every provider, so the model
 * set on the key never decides whether structured output works.
 *
 * Two real-world defects this fixes (both seen in production):
 *
 *  1. **OpenAI `{name, schema, strict}` envelope stored verbatim.** Some keys hold
 *     the full OpenAI `response_format.json_schema` object instead of a bare JSON
 *     Schema. Passed through as-is, Anthropic rejects it ("Empty schema ({}) …")
 *     and — worse — Ajv treats the envelope as "accept anything", so the output is
 *     never actually validated. We UNWRAP to the inner schema.
 *
 *  2. **Optional properties under OpenAI strict mode.** OpenAI strict structured
 *     output requires every key in `properties` to appear in `required` and
 *     `additionalProperties:false`. A schema with an optional field 400s. We
 *     STRICT-NORMALIZE: every property becomes required, genuinely-optional ones
 *     are expressed as nullable (a union with `"null"`) — exactly how OpenAI
 *     wants "optional" spelled — and objects get `additionalProperties:false`.
 *
 * The result is one canonical schema that OpenAI strict mode accepts natively and
 * that Anthropic/Google accept too — so the native (fast) path is taken on every
 * provider, with the tolerant fallback in `structured.ts` as a backstop. The same
 * normalized schema is used for our own Ajv validation, closing the "envelope =
 * no validation" hole. Normalization is idempotent.
 */

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keys that mean "this object IS a JSON Schema" rather than an OpenAI envelope. */
const SCHEMA_MARKER_KEYS = ['type', 'properties', '$ref', 'anyOf', 'oneOf', 'allOf', 'enum', 'items'];

/**
 * Unwrap an OpenAI `response_format` envelope down to the bare JSON Schema.
 * Handles `{ name, schema, strict }` and a nested `{ json_schema: { schema } }`.
 * Only unwraps when the outer object is clearly an envelope (carries a `schema`
 * object and none of the schema-defining keywords), so a real schema with a
 * property coincidentally named `schema` is left untouched.
 */
export function unwrapResponseFormat(input: unknown): unknown {
  let node = input;
  // `{ type: 'json_schema', json_schema: {...} }` → step inside json_schema.
  if (isPlainObject(node) && isPlainObject(node.json_schema)) node = node.json_schema;
  // `{ name?, schema, strict? }` envelope → step inside schema.
  while (
    isPlainObject(node) &&
    isPlainObject(node.schema) &&
    !SCHEMA_MARKER_KEYS.some((k) => k in (node as Json))
  ) {
    node = node.schema;
  }
  return node;
}

/** Add `"null"` to a node's permitted types, preserving the rest of the node. */
function makeNullable(node: unknown): unknown {
  if (!isPlainObject(node)) return { anyOf: [node, { type: 'null' }] };
  if (typeof node.type === 'string') {
    return node.type === 'null' ? node : { ...node, type: [node.type, 'null'] };
  }
  if (Array.isArray(node.type)) {
    return node.type.includes('null') ? node : { ...node, type: [...node.type, 'null'] };
  }
  if (Array.isArray(node.enum)) {
    return node.enum.includes(null) ? node : { ...node, enum: [...node.enum, null] };
  }
  // No `type`/`enum` to widen (e.g. a bare `$ref` or composed schema): union with null.
  return { anyOf: [node, { type: 'null' }] };
}

/**
 * Recursively rewrite a JSON Schema so OpenAI strict mode accepts it: for every
 * object node with `properties`, require all of them and set
 * `additionalProperties:false`; properties that weren't already required are made
 * nullable so their "optional" intent survives. Recurses through `properties`,
 * `items`, and `anyOf`/`oneOf`/`allOf`/`$defs`/`definitions`.
 */
export function toStrictSchema(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(toStrictSchema);
  if (!isPlainObject(input)) return input;

  const node: Json = { ...input };

  if (isPlainObject(node.properties)) {
    const props = node.properties as Json;
    const originalRequired = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const rewritten: Json = {};
    for (const key of Object.keys(props)) {
      const child = toStrictSchema(props[key]);
      rewritten[key] = originalRequired.has(key) ? child : makeNullable(child);
    }
    node.properties = rewritten;
    node.required = Object.keys(props);
    node.additionalProperties = false;
  }

  if ('items' in node) node.items = toStrictSchema(node.items);
  for (const comb of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(node[comb])) node[comb] = (node[comb] as unknown[]).map(toStrictSchema);
  }
  for (const defs of ['$defs', 'definitions'] as const) {
    if (isPlainObject(node[defs])) {
      const src = node[defs] as Json;
      const out: Json = {};
      for (const k of Object.keys(src)) out[k] = toStrictSchema(src[k]);
      node[defs] = out;
    }
  }
  return node;
}

/**
 * Canonicalize a key's stored output schema: unwrap any OpenAI envelope, then
 * strict-normalize. Safe to call on an already-clean schema (idempotent) and on
 * a non-object value (returned unchanged). This is the single entry point the
 * proxy uses when reading `key.outputSchema`.
 */
export function normalizeOutputSchema(input: unknown): Record<string, unknown> {
  const unwrapped = unwrapResponseFormat(input);
  const strict = toStrictSchema(unwrapped);
  return isPlainObject(strict) ? strict : (unwrapped as Record<string, unknown>);
}
