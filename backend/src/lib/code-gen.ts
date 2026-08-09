// Round 11 — shared helpers for auto-generated short codes used in SKUs
// (ShopCode-CategoryCode-Year-Serial, e.g. "FTS-SHI-26-0001"). Both are pure
// suggestions: every caller lets the human override the result, and
// uniqueness against sibling codes is enforced by the caller via uniqueCode,
// not baked into abbreviateToCode itself.

export function abbreviateToCode(name: string, len = 3): string {
  const words = name
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'GEN';

  let code: string;
  if (words.length >= len) {
    code = words
      .slice(0, len)
      .map((w) => w[0])
      .join('');
  } else if (words.length > 1) {
    const initials = words.map((w) => w[0]).join('');
    code = initials + words[words.length - 1].slice(1);
  } else {
    code = words[0];
  }

  code = code.toUpperCase();
  return code.length >= len ? code.slice(0, len) : code.padEnd(len, 'X');
}

// Appends a numeric suffix (SHI2, SHI3, ...) until `base` doesn't collide
// with anything in `existing` (case-insensitive).
export function uniqueCode(base: string, existing: Iterable<string>): string {
  const taken = new Set(Array.from(existing, (c) => c.toUpperCase()));
  if (!taken.has(base.toUpperCase())) return base;
  let n = 2;
  while (taken.has(`${base}${n}`.toUpperCase())) n += 1;
  return `${base}${n}`;
}
