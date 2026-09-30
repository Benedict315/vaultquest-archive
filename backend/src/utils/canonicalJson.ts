/**
 * Canonical JSON (#812, #814).
 *
 * Receipts are signed and audit records are hash-chained, so the bytes that
 * get signed/hashed must not depend on object key order or on how a value was
 * built. This serializer:
 *
 *  - sorts object keys lexicographically at every depth,
 *  - drops `undefined` object values (JSON has no undefined),
 *  - renders `Date` as its ISO string and `bigint` as a decimal string,
 *  - rejects non-finite numbers, functions and symbols instead of silently
 *    turning them into `null` (a silent change would make a signature verify
 *    against data that was never signed).
 *
 * It is deliberately independent of `ledger.ts` so signing never depends on
 * that module loading.
 */

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
      // Only reachable at the top level or inside arrays; objects skip it.
      return "null";
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
}
