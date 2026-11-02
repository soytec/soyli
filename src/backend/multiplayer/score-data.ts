/** Bounded JSON Schema subset for public score attachments, independent of NAP-CONFIG. */
export const SCORE_DATA_BYTES = 8192;
export const SCORE_SCHEMA_BYTES = 8192;
export type ScoreDataSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, ScoreDataSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ScoreDataSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  enum?: (string | number | boolean | null)[];
  title?: string;
  description?: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeKey = (key: string) =>
  key.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(key);
function fail(path: string, message: string): never {
  // Paths describe schema fields, never submitted values or entire payloads.
  throw new Error(`${path}: ${message}`);
}

function boundedJson(input: unknown, label: string, maxBytes: number, maxDepth: number) {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 2048 || depth > maxDepth)
      fail(label, `JSON exceeds the nesting or node limit (${maxDepth} levels, 2048 values)`);
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && value.length <= maxBytes) return;
    if (Array.isArray(value) || record(value)) {
      if (seen.has(value)) fail(label, 'JSON must not contain cycles');
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length > 256) fail(label, 'Arrays may contain at most 256 items');
        for (const item of value) visit(item, depth + 1);
      } else {
        const keys = Object.keys(value);
        if (keys.length > 64) fail(label, 'Objects may contain at most 64 fields');
        for (const key of keys) {
          if (!safeKey(key)) fail(label, 'Invalid JSON field name');
          visit(value[key], depth + 1);
        }
      }
      seen.delete(value);
      return;
    }
    fail(label, 'Use finite, bounded JSON values');
  };
  visit(input, 0);
  const json = JSON.stringify(input);
  if (new TextEncoder().encode(json).length > maxBytes)
    fail(label, `JSON exceeds ${maxBytes} UTF-8 bytes`);
  return json;
}

const keywords: Record<ScoreDataSchema['type'], string[]> = {
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'minItems', 'maxItems'],
  string: ['minLength', 'maxLength', 'enum'],
  number: ['minimum', 'maximum', 'enum'],
  integer: ['minimum', 'maximum', 'enum'],
  boolean: ['enum'],
  null: ['enum'],
};

/** Reject unsupported constraints instead of silently accepting a weaker schema. */
export function validateScoreDataSchema(input: unknown): ScoreDataSchema {
  boundedJson(input, 'dataSchema', SCORE_SCHEMA_BYTES, 20);
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): void => {
    if (!record(value) || typeof value.type !== 'string' || !Object.hasOwn(keywords, value.type))
      fail(path, 'Declare a supported JSON type');
    if (++nodes > 128 || depth > 8) fail(path, 'Schema exceeds 8 levels or 128 schema nodes');
    const allowed = [
      'type',
      'title',
      'description',
      ...keywords[value.type as ScoreDataSchema['type']],
    ];
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) fail(path, `Unsupported schema keyword ${key}`);
    for (const key of ['title', 'description'])
      if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 512))
        fail(path, `${key} must be text of at most 512 characters`);
    for (const [min, max, cap] of [
      ['minimum', 'maximum', undefined],
      ['minLength', 'maxLength', SCORE_DATA_BYTES],
      ['minItems', 'maxItems', 256],
    ] as const) {
      for (const key of [min, max]) {
        const bound = value[key];
        if (
          bound !== undefined &&
          (typeof bound !== 'number' ||
            !Number.isFinite(bound) ||
            (cap !== undefined && (!Number.isSafeInteger(bound) || bound < 0 || bound > cap)))
        )
          fail(
            path,
            `${key} must be a finite${cap === undefined ? '' : ` non-negative integer up to ${cap}`} bound`,
          );
      }
      if (
        value[min] !== undefined &&
        value[max] !== undefined &&
        Number(value[min]) > Number(value[max])
      )
        fail(path, `${min} must not exceed ${max}`);
    }
    if (value.type === 'object') {
      if (value.properties !== undefined && !record(value.properties))
        fail(path, 'properties must be a schema map');
      const properties = (value.properties ?? {}) as Record<string, unknown>;
      if (
        value.additionalProperties !== undefined &&
        typeof value.additionalProperties !== 'boolean'
      )
        fail(path, 'additionalProperties must be boolean');
      if (
        value.required !== undefined &&
        (!Array.isArray(value.required) ||
          value.required.some(
            (key) => typeof key !== 'string' || !Object.hasOwn(properties, key),
          ) ||
          new Set(value.required).size !== value.required.length)
      )
        fail(path, 'required must name distinct declared fields');
      for (const [key, child] of Object.entries(properties))
        visit(child, `${path}.${key}`, depth + 1);
    }
    if (value.type === 'array') visit(value.items, `${path}[]`, depth + 1);
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 32)
        fail(path, 'enum needs 1–32 primitive choices');
      const schema = { ...value } as ScoreDataSchema;
      delete schema.enum;
      for (const item of value.enum) validateValue(schema, item, path);
      if (new Set(value.enum).size !== value.enum.length)
        fail(path, 'enum choices must be distinct');
    }
  };
  visit(input, 'dataSchema', 0);
  if ((input as ScoreDataSchema).type !== 'object') fail('dataSchema', 'Root must be an object');
  return input as ScoreDataSchema;
}

function validateValue(schema: ScoreDataSchema, value: unknown, path: string): void {
  switch (schema.type) {
    case 'object': {
      if (!record(value)) fail(path, 'Expected an object');
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'Required field is missing');
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) validateValue(properties[key], item, `${path}.${key}`);
        else if (schema.additionalProperties === false)
          fail(path, 'Undeclared field; check the registered dataSchema');
      }
      break;
    }
    case 'array':
      if (
        !Array.isArray(value) ||
        value.length < (schema.minItems ?? 0) ||
        value.length > (schema.maxItems ?? 256)
      )
        fail(path, 'Expected an array within the declared item limits');
      for (const item of value) validateValue(schema.items!, item, `${path}[]`);
      break;
    case 'string':
      if (
        typeof value !== 'string' ||
        [...value].length < (schema.minLength ?? 0) ||
        [...value].length > (schema.maxLength ?? SCORE_DATA_BYTES)
      )
        fail(path, 'Expected text within the declared length limits');
      break;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity)
      )
        fail(path, `Expected a finite ${schema.type} within the declared range`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, 'Expected a boolean');
      break;
    case 'null':
      if (value !== null) fail(path, 'Expected null');
  }
  if (schema.enum && !schema.enum.some((item) => item === value))
    fail(path, 'Value is not an allowed choice');
}

/** The schema is already validated at registration; no coercion, defaults or fetching URLs. */
export function encodeScoreData(
  schema: ScoreDataSchema | undefined,
  input: unknown,
): string | null {
  if (!schema) {
    if (input !== undefined)
      fail('data', 'This board has no dataSchema; register a new board with attachment rules');
    return null;
  }
  if (input === undefined)
    fail('data', 'This board requires data matching its registered dataSchema');
  const json = boundedJson(input, 'data', SCORE_DATA_BYTES, 8);
  validateValue(schema, input, 'data');
  return json;
}
