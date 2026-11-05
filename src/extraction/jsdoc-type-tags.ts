/**
 * Spec 0066 — parse JSDoc `@returns` / `@param` type tags as a fallback when
 * the signature has no usable return/param type name. Docstring text still
 * lives on `nodes.docstring` (Spec 0020); this only extracts type *names*.
 */

const PRIMITIVE_OR_VOID = new Set([
  'void',
  'undefined',
  'null',
  'never',
  'any',
  'unknown',
  'object',
  'Object',
  'string',
  'String',
  'number',
  'Number',
  'boolean',
  'Boolean',
  'bigint',
  'symbol',
  'Symbol',
  'this',
  'self',
  'static',
]);

/**
 * Unwrap Promise/Array/… and strip arrays/generics to a bare type identifier.
 * Returns undefined for empty / primitive / void-like results.
 */
export function extractBaseTypeName(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let t = raw.trim();
  if (!t) return undefined;

  // Drop leading `readonly` / `export` noise occasionally glued into tags.
  t = t.replace(/^(?:readonly|export|declare)\s+/i, '').trim();

  // Take the first union arm: `Foo | null` → `Foo`.
  if (t.includes('|')) {
    t = t.split('|')[0]!.trim();
  }

  // Function type → skip (no single type node).
  if (t.includes('=>')) return undefined;

  if (t.endsWith('[]')) {
    t = t.slice(0, -2).trim();
  }

  const wrapper = t.match(
    /^(?:Promise|Array|ReadonlyArray|Callback|Set|Iterable|Partial|Required|Readonly)\s*<\s*(.+)\s*>$/i
  );
  if (wrapper?.[1]) {
    t = wrapper[1].trim();
    // Nested commas in Map/Record — take last type arg when present.
    if (t.includes(',')) {
      const mapLike = t.match(/^(?:Map|Record)\s*<[^,]+,\s*(.+)>$/i);
      if (mapLike?.[1]) t = mapLike[1].trim();
      else t = t.split(',').pop()!.trim();
    }
  }

  const mapMatch = t.match(/^(?:Map|Record)\s*<[^,]+,\s*(.+)>$/i);
  if (mapMatch?.[1]) t = mapMatch[1].trim();

  // Strip remaining generics: `Foo<T>` → `Foo`
  t = t.replace(/<[^>]*>/g, '').replace(/\[\]/g, '').trim();
  if (!t) return undefined;

  // Qualified → trailing simple name (`ns.Bar` → `Bar`)
  const simple = t.split('.').filter(Boolean).pop() ?? t;
  if (!simple || PRIMITIVE_OR_VOID.has(simple)) return undefined;
  // Must look like an identifier (PascalCase preferred but allow any word).
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(simple)) return undefined;
  return simple;
}

/** `@returns {Type}` or `@return Type` → base type name. */
export function parseJsdocReturns(docstring: string | undefined | null): string | undefined {
  if (!docstring) return undefined;
  const re = /@returns?\s+(?:\{([^}]+)\}|([A-Za-z_][\w.<>[\],\s|]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(docstring)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    const base = extractBaseTypeName(raw);
    if (base) return base;
  }
  return undefined;
}

export interface JsdocParamType {
  paramName: string;
  typeName: string;
}

/** `@param {Type} name` entries with a resolvable type name. */
export function parseJsdocParams(docstring: string | undefined | null): JsdocParamType[] {
  if (!docstring) return [];
  const out: JsdocParamType[] = [];
  const re = /@param(?:eter)?\s+(?:\{([^}]+)\}\s+)?\[?(\w+)\]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(docstring)) !== null) {
    const typeRaw = m[1]?.trim();
    const paramName = m[2];
    if (!typeRaw || !paramName) continue;
    const typeName = extractBaseTypeName(typeRaw);
    if (typeName) out.push({ paramName, typeName });
  }
  return out;
}
