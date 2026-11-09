/**
 * Deterministic Canonical JSON Serialization (RFC 8785 / JCS subset)
 * Ensures identical UTF-8 byte representation across Windows and Ubuntu Linux
 * before signing or verifying Ed25519 signatures on SignedP2PReleaseIndex.
 */

export function canonicalizeJson(value) {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON does not permit NaN or Infinity');
    }
    if (Object.is(value, -0)) {
      return '0';
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const elements = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        elements.push('null');
      } else {
        elements.push(canonicalizeJson(item));
      }
    }
    return '[' + elements.join(',') + ']';
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = [];
    for (const key of keys) {
      const propVal = value[key];
      if (propVal === undefined || typeof propVal === 'function' || typeof propVal === 'symbol') {
        continue;
      }
      pairs.push(JSON.stringify(key) + ':' + canonicalizeJson(propVal));
    }
    return '{' + pairs.join(',') + '}';
  }

  throw new TypeError(`Unsupported type in canonicalizeJson: ${typeof value}`);
}

export function canonicalizeJsonBuffer(value) {
  return Buffer.from(canonicalizeJson(value), 'utf8');
}
