import { z } from 'zod';
import { BackendError, LIMITS } from './contracts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Shape = {
  type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  properties?: Record<string, Shape>;
  required?: string[];
  additionalProperties?: false;
  items?: Shape;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: (string | number | boolean | null)[];
};
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const forbidden = (key: string) => ['__proto__', 'prototype', 'constructor'].includes(key);
const fail = (message: string): never => {
  throw new BackendError('BAD_INPUT', message);
};
export function jsonBytes(value: unknown, maximum: number = LIMITS.jsonBytes): string {
  const seen = new Set<unknown>();
  let nodes = 0;
  function visit(v: unknown, depth: number) {
    if (++nodes > 16384 || depth > 20) fail('JSON nesting or node limit exceeded.');
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return;
    if (typeof v === 'string') {
      if (v.length > maximum) fail('JSON string exceeds byte budget.');
      return;
    }
    if (!Array.isArray(v) && !plain(v)) fail('Use plain, finite JSON values.');
    if (seen.has(v)) fail('Cyclic JSON is not supported.');
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > 4096) fail('Array exceeds 4096 items.');
      for (const item of v) visit(item, depth + 1);
    } else {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > 256) fail('Object exceeds 256 fields.');
      for (const [key, item] of entries) {
        if (key.length > 128 || forbidden(key)) fail('Invalid JSON field name.');
        visit(item, depth + 1);
      }
    }
    seen.delete(v);
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maximum) fail(`JSON exceeds ${maximum} UTF-8 bytes.`);
  return encoded;
}
const allowed: Record<string, string[]> = {
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'minItems', 'maxItems'],
  string: ['minLength', 'maxLength', 'enum'],
  integer: ['minimum', 'maximum', 'enum'],
  number: ['minimum', 'maximum', 'enum'],
  boolean: ['enum'],
  null: ['enum'],
};
export function admitShape(input: unknown): Shape {
  jsonBytes(input, LIMITS.schemaBytes);
  let nodes = 0;
  function visit(s: unknown, depth: number) {
    if (
      ++nodes > 256 ||
      depth > 10 ||
      !plain(s) ||
      typeof s.type !== 'string' ||
      !Object.hasOwn(allowed, s.type)
    )
      fail('Schema needs a supported type within the depth/node budget.');
    const shape = s as Record<string, unknown>,
      type = shape.type as string;
    for (const key of Object.keys(shape))
      if (!['type', ...allowed[type]].includes(key)) fail(`Unsupported schema keyword: ${key}.`);
    if (type === 'object') {
      if (!plain(shape.properties) || shape.additionalProperties !== false)
        fail('Object schemas require properties and additionalProperties: false.');
      if (
        !Array.isArray(shape.required) ||
        shape.required.some(
          (key) => typeof key !== 'string' || !Object.hasOwn(shape.properties as object, key),
        ) ||
        new Set(shape.required).size !== shape.required.length
      )
        fail('required must list distinct declared fields.');
      for (const child of Object.values(shape.properties as object)) visit(child, depth + 1);
    }
    if (type === 'array') {
      visit(shape.items, depth + 1);
      if (
        !Number.isSafeInteger(shape.maxItems) ||
        Number(shape.maxItems) > 4096 ||
        Number(shape.maxItems) < 0
      )
        fail('Arrays require maxItems between 0 and 4096.');
    }
    if (
      type === 'string' &&
      (!Number.isSafeInteger(shape.maxLength) ||
        Number(shape.maxLength) > 65536 ||
        Number(shape.maxLength) < 0)
    )
      fail('Strings require a bounded maxLength.');
    for (const [min, max] of [
      ['minimum', 'maximum'],
      ['minLength', 'maxLength'],
      ['minItems', 'maxItems'],
    ]) {
      for (const field of [min, max])
        if (
          shape[field] !== undefined &&
          (typeof shape[field] !== 'number' ||
            !Number.isFinite(shape[field]) ||
            (field !== 'minimum' &&
              field !== 'maximum' &&
              (!Number.isSafeInteger(shape[field]) || Number(shape[field]) < 0)))
        )
          fail('Invalid schema bound.');
      if (
        shape[min] !== undefined &&
        shape[max] !== undefined &&
        Number(shape[min]) > Number(shape[max])
      )
        fail('Minimum must not exceed maximum.');
    }
    if (shape.enum !== undefined) {
      if (
        !Array.isArray(shape.enum) ||
        !shape.enum.length ||
        shape.enum.length > 64 ||
        new Set(shape.enum).size !== shape.enum.length
      )
        fail('enum needs 1–64 distinct primitive choices.');
      for (const item of shape.enum as unknown[])
        validateValue({ ...shape, enum: undefined } as Shape, item);
    }
  }
  visit(input, 0);
  return input as Shape;
}
export function validateValue(schema: Shape, value: unknown): void {
  switch (schema.type) {
    case 'object':
      if (!plain(value)) fail('Expected an object.');
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(value as object, key)) fail(`Missing required field: ${key}.`);
      for (const [key, child] of Object.entries(value as object)) {
        if (!Object.hasOwn(schema.properties!, key)) fail(`Undeclared field: ${key}.`);
        validateValue(schema.properties![key], child);
      }
      break;
    case 'array':
      if (
        !Array.isArray(value) ||
        value.length < (schema.minItems ?? 0) ||
        value.length > schema.maxItems!
      )
        fail('Array length outside schema bounds.');
      for (const child of value as unknown[]) validateValue(schema.items!, child);
      break;
    case 'string':
      if (
        typeof value !== 'string' ||
        [...value].length < (schema.minLength ?? 0) ||
        [...value].length > schema.maxLength!
      )
        fail('String outside schema bounds.');
      break;
    case 'integer':
    case 'number':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity)
      )
        fail('Number outside schema bounds.');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('Expected boolean.');
      break;
    case 'null':
      if (value !== null) fail('Expected null.');
  }
  if (schema.enum && !schema.enum.some((item) => item === value))
    fail('Value is not an allowed choice.');
}
export const operationSchema = z
  .object({
    effect: z.enum(['create', 'query', 'command']),
    access: z.enum(['reader', 'writer', 'owner']),
    account: z.boolean(),
    input: z.unknown(),
    output: z.unknown(),
  })
  .strict();
const schemasEnvelope = z
  .object({
    version: z.literal(1),
    records: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), z.unknown()),
    operations: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), operationSchema),
  })
  .strict();
export type Schemas = {
  version: 1;
  records: Record<string, Shape>;
  operations: Record<
    string,
    {
      effect: 'create' | 'query' | 'command';
      access: 'reader' | 'writer' | 'owner';
      account: boolean;
      input: Shape;
      output: Shape;
    }
  >;
};
export function admitSchemas(value: unknown): Schemas {
  jsonBytes(value, LIMITS.schemaBytes);
  const schemas = schemasEnvelope.parse(value);
  if (
    !Object.keys(schemas.operations).length ||
    Object.keys(schemas.operations).length > LIMITS.operations ||
    Object.keys(schemas.records).length > 32
  )
    fail('Too many or no operation schemas.');
  for (const shape of Object.values(schemas.records)) admitShape(shape);
  for (const op of Object.values(schemas.operations)) {
    admitShape(op.input);
    admitShape(op.output);
    if ((op.input as Shape).type !== 'object' || (op.output as Shape).type !== 'object')
      fail('Operation input/output roots must be objects.');
  }
  return schemas as Schemas;
}
