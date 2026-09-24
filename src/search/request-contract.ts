/** Grounded request data, never repository facts or benchmark acceptance answers. */
export const TARGET_ROLES = ['page', 'literal', 'symbol', 'object'] as const;
export const OBJECT_KINDS = ['ui', 'form', 'native'] as const;
export const BEHAVIOR_KINDS = ['enabled', 'visibility', 'event', 'state', 'route', 'runtime'] as const;
export interface RequestTarget {
  id: string;
  text: string;
  role: typeof TARGET_ROLES[number];
  presence: 'existing' | 'requested';
  objectKind?: typeof OBJECT_KINDS[number];
}
export interface BehaviorObligation {
  id: string;
  text: string;
  kind: typeof BEHAVIOR_KINDS[number];
  targetId?: string;
}
export interface RequestContract { targets: RequestTarget[]; obligations: BehaviorObligation[] }
export const accuracyTargetsEnabled = (): boolean => process.env.HOMEGRAPH_ACCURACY_TARGETS !== '0';
export const accuracyCoverageEnabled = (): boolean => process.env.HOMEGRAPH_ACCURACY_COVERAGE !== '0';

/** No repair of invented text, no unknown enum values, no generated identifiers. */
export function validateRequestContract(value: unknown, original: string): RequestContract | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => { throw new Error('invalid_request_contract'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.targets) || v.targets.length > 6 || !Array.isArray(v.obligations) || v.obligations.length > 6) return fail();
  if (Object.keys(v).some(key => !['targets', 'obligations'].includes(key))) return fail();
  const ids = new Set<string>();
  const record = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[A-Za-z][\w-]{0,15}$/.test(r.id) || ids.has(r.id)
      || typeof r.text !== 'string' || r.text.trim() !== r.text || r.text.length < 2 || r.text.length > 256
      || /[\u0000-\u001f\u007f]/.test(r.text) || !original.includes(r.text)) return fail();
    ids.add(r.id); return r;
  };
  const targets: RequestTarget[] = v.targets.map(raw => {
    const r = record(raw);
    if (Object.keys(r).some(key => !['id', 'text', 'role', 'presence', 'objectKind'].includes(key))) return fail();
    if (!(TARGET_ROLES as readonly unknown[]).includes(r.role) || !['existing', 'requested'].includes(r.presence as string)
      || (r.objectKind !== undefined && !(OBJECT_KINDS as readonly unknown[]).includes(r.objectKind))) return fail();
    return { id: r.id as string, text: r.text as string, role: r.role as RequestTarget['role'],
      presence: r.presence as RequestTarget['presence'], ...(r.objectKind ? { objectKind: r.objectKind as RequestTarget['objectKind'] } : {}) };
  });
  const obligations: BehaviorObligation[] = v.obligations.map(raw => {
    const r = record(raw);
    if (Object.keys(r).some(key => !['id', 'text', 'kind', 'targetId'].includes(key))) return fail();
    if (!(BEHAVIOR_KINDS as readonly unknown[]).includes(r.kind)
      || (r.targetId !== undefined && !targets.some(t => t.id === r.targetId))) return fail();
    return { id: r.id as string, text: r.text as string, kind: r.kind as BehaviorObligation['kind'],
      ...(r.targetId ? { targetId: r.targetId as string } : {}) };
  });
  return { targets, obligations };
}

/** Fallback deliberately cannot decide whether quoted text should already exist. */
export function ruleRequestContract(original: string, literals: string[]): RequestContract | undefined {
  const targets: RequestTarget[] = literals.slice(0, 6).map((text, i) => ({ id: `t${i + 1}`, text, role: 'literal', presence: 'requested' }));
  // A small language-level behavior trigger, not a list of task names or expected answers.
  const statements = original.split(/[\n。；;]/).map(s => s.trim()).filter(Boolean);
  const obligations: BehaviorObligation[] = statements.filter(s => /禁用|启用|\bdisabl(?:e|ed|ing)\b|\benabl(?:e|ed|ing)\b/i.test(s))
    .slice(0, 6).map((s, i) => {
      const named = targets.filter(t => s.includes(t.text));
      return { id: `b${i + 1}`, text: s.slice(0, 256), kind: 'enabled', ...(named.length === 1 ? { targetId: named[0]!.id } : {}) };
    });
  return targets.length || obligations.length ? { targets, obligations } : undefined;
}

export function contractLiteralTexts(contract?: RequestContract): string[] {
  return (contract?.targets ?? []).filter(t => t.role === 'literal' || t.role === 'page').map(t => t.text);
}
