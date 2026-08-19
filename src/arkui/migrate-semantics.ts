/**
 * ArkUI migrate-snapshot semantics (spec 0007).
 * Pure helpers + constants — no DB / MCP.
 */

export type PassageType =
  | 'two_way_binding'
  | 'state_variable_ref'
  | 'new_instance'
  | 'callback'
  | 'literal'
  | 'function_call'
  | 'expression';

export type ValueTypeKind = 'simple' | 'builtin' | 'class' | 'unknown';

export type AppChannel =
  | 'ProvideConsume'
  | 'AppStorage'
  | 'LocalStorage'
  | 'PersistentStorage'
  | 'Environment'
  | 'AppStorageV2'
  | 'PersistenceV2';

export const V1_STATE_DECORATORS = new Set([
  'State',
  'Prop',
  'Link',
  'ObjectLink',
  'Provide',
  'Consume',
  'Watch',
  'StorageLink',
  'StorageProp',
  'LocalStorageLink',
  'LocalStorageProp',
  'Observed',
  'Track',
  'Require',
]);

export const V2_STATE_DECORATORS = new Set([
  'Local',
  'Param',
  'Event',
  'Provider',
  'Consumer',
  'Monitor',
  'Trace',
  'Computed',
  'Once',
  'ObservedV2',
]);

export const AUX_DECORATORS = new Set(['Watch', 'Monitor', 'Once', 'Require']);

export const MAIN_STATE_DECORATORS = new Set(
  [...V1_STATE_DECORATORS, ...V2_STATE_DECORATORS].filter((k) => !AUX_DECORATORS.has(k))
);

export const KEY_CHANNEL_DECORATORS = new Set([
  'Provide',
  'Provider',
  'Consume',
  'Consumer',
  'StorageProp',
  'StorageLink',
  'LocalStorageProp',
  'LocalStorageLink',
]);

export const STORAGE_KEY_DECORATORS = new Set([
  'StorageLink',
  'StorageProp',
  'LocalStorageLink',
  'LocalStorageProp',
]);

export const COMPONENT_CONTAINER_DECORATORS = new Set([
  'Component',
  'ComponentV2',
  'CustomDialog',
]);

export const OBSERVATION_DECORATORS = new Set(['Observed', 'ObservedV2']);

export const TRACE_DECORATORS = new Set(['Track', 'Trace', 'Type']);

/** Bare kind + optional `Kind@arg` twin so existing `includes('State')` checks keep working. */
export function encodeDecoratorEntries(
  entries: Array<{ kind: string; arg?: string | null }>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { kind, arg } of entries) {
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
    if (arg) out.push(`${kind}@${arg}`);
  }
  return out;
}

export function parseDecoratorArgFromContent(content: string | undefined | null): string | null {
  if (!content) return null;
  const m = content.match(/^\w+\(\s*['"`]([^'"`]+)['"`]/);
  return m?.[1] ?? null;
}

export function decodeDecorators(decorators: string[] | undefined): {
  kinds: string[];
  argByKind: Map<string, string>;
} {
  const kinds: string[] = [];
  const argByKind = new Map<string, string>();
  for (const d of decorators ?? []) {
    const at = d.indexOf('@');
    if (at > 0) {
      argByKind.set(d.slice(0, at), d.slice(at + 1));
    } else {
      kinds.push(d);
    }
  }
  return { kinds, argByKind };
}

export function mainStateDecorator(kinds: string[]): string | undefined {
  return kinds.find((k) => MAIN_STATE_DECORATORS.has(k) && !OBSERVATION_DECORATORS.has(k));
}

export function channelOfKeyDecorator(decorator: string): AppChannel {
  if (decorator === 'StorageProp' || decorator === 'StorageLink') return 'AppStorage';
  if (decorator === 'LocalStorageProp' || decorator === 'LocalStorageLink') return 'LocalStorage';
  return 'ProvideConsume';
}

/** Decorators whose key defaults to the field name when no literal arg is given. */
export const IMPLICIT_NAME_KEY_DECORATORS = new Set([
  'Provide',
  'Consume',
  'Provider',
  'Consumer',
]);

/**
 * Resolve the storage / ProvideConsume key for a state var (spec 0014).
 * Explicit decorator arg wins; Provide/Consume(/V2) fall back to the variable name.
 * Storage* decorators never fall back — missing arg means no channel.
 */
export function resolveKeyChannelKey(
  decorator: string,
  decoratorArg: string | undefined,
  fieldName: string
): string | undefined {
  const arg = decoratorArg?.trim();
  if (arg) return arg;
  if (IMPLICIT_NAME_KEY_DECORATORS.has(decorator)) {
    const name = fieldName.trim();
    return name || undefined;
  }
  return undefined;
}

export function channelOfStorageApiClass(cls: string): AppChannel | null {
  switch (cls) {
    case 'AppStorage':
      return 'AppStorage';
    case 'LocalStorage':
      return 'LocalStorage';
    case 'PersistentStorage':
      return 'PersistentStorage';
    case 'Environment':
      return 'Environment';
    case 'AppStorageV2':
      return 'AppStorageV2';
    case 'PersistenceV2':
      return 'PersistenceV2';
    default:
      return null;
  }
}

/** Builtin container / date types (migration-graph valueType). */
const BUILTIN_TYPE_NAMES = new Set([
  'Array',
  'Map',
  'Set',
  'Date',
  'WeakMap',
  'WeakSet',
  'ArrayBuffer',
  'TypedArray',
]);

const SIMPLE_TYPE_RE =
  /^(number|string|boolean|bigint|null|undefined|void|any|never)$/i;
/** ALL_CAPS enum-ish tokens (not PascalCase class names). */
const ENUMISH_TYPE_RE = /^[A-Z][A-Z0-9_]+$/;

export function classifyValueType(typeStr: string | undefined | null): ValueTypeKind {
  if (!typeStr) return 'unknown';
  const t = typeStr.trim();
  if (!t || t === 'unknown' || t === 'Any' || t === 'any') return 'unknown';
  if (SIMPLE_TYPE_RE.test(t) || ENUMISH_TYPE_RE.test(t) || /^'[^']*'$/.test(t) || /^"[^"]*"$/.test(t)) {
    return 'simple';
  }
  // Array<T> / T[] / Map<...>
  if (/\[\]$/.test(t) || /^(Array|Map|Set|WeakMap|WeakSet|Date)\b/.test(t)) return 'builtin';
  const bare = t.replace(/<.*>/, '').split('.').pop() ?? t;
  if (BUILTIN_TYPE_NAMES.has(bare)) return 'builtin';
  if (/^[A-Z][A-Za-z0-9_]*$/.test(bare)) return 'class';
  return 'unknown';
}

export function computeForcesMigration(
  passageType: PassageType,
  valueType: ValueTypeKind
): boolean {
  if (passageType === 'two_way_binding') return true;
  if (passageType !== 'state_variable_ref') return false;
  return valueType === 'builtin' || valueType === 'class';
}

export function classifyPassageFromText(
  text: string,
  opts?: { childDecorator?: string; parentHasField?: (name: string) => boolean }
): PassageType {
  if (text.includes('$$') || text.includes('!!')) return 'two_way_binding';
  if (opts?.childDecorator === 'BuilderParam') return 'callback';

  const fieldRef = text.match(/^this\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (fieldRef) {
    const name = fieldRef[1]!;
    if (opts?.parentHasField && !opts.parentHasField(name)) return 'callback';
    return 'state_variable_ref';
  }

  if (/^\$[A-Za-z_]/.test(text.trim())) return 'two_way_binding';
  if (/^new\s+/.test(text.trim())) return 'new_instance';
  if (/^['"`]/.test(text.trim()) || /^(true|false|null|undefined|\d)/.test(text.trim())) {
    return 'literal';
  }
  if (/\(.*\)\s*$/.test(text.trim()) && !text.includes('=>')) return 'function_call';
  if (text.includes('=>') || text.startsWith('<builder:')) return 'callback';
  return 'expression';
}

/** Scan ETS source for AppStorage / LocalStorage / … literal keys. */
export const STORAGE_API_CALL_RE =
  /\b(AppStorage|LocalStorage|PersistentStorage|Environment|AppStorageV2|PersistenceV2)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*['"`]([^'"`]+)['"`]/g;

export interface StorageApiHit {
  channel: AppChannel;
  key: string;
  method: string;
  cls: string;
  index: number;
}

export function scanStorageApiKeys(source: string): StorageApiHit[] {
  const out: StorageApiHit[] = [];
  const seen = new Set<string>();
  STORAGE_API_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STORAGE_API_CALL_RE.exec(source)) !== null) {
    const cls = m[1]!;
    const method = m[2]!;
    const key = m[3]!;
    const channel = channelOfStorageApiClass(cls);
    if (!channel) continue;
    const dedupe = `${channel}:${key}:${method}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ channel, key, method, cls, index: m.index });
  }
  return out;
}

export function lineOfOffset(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}
