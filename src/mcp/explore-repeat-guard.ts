/**
 * Session-level explore repeat / partial guidance (generic).
 *
 * Stops agents from treating `homegraph_explore` as an iterative keyword
 * searcher: overlapping queries after a successful explore get a short refuse
 * instead of another multi-kB payload. Partial/busy replies carry concrete
 * retry anchors extracted from the query — never an empty 242-char shell.
 *
 * Shape-driven only — no product nouns.
 */

import type { ExploreCallRecord, ExploreProjectState } from './explore-session-state';

/** Tokens that do not distinguish one explore bag from another. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'how', 'what', 'which', 'where', 'when', 'why', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'be', 'been', 'this', 'that', 'these', 'those',
  '项目', '工程', '代码', '功能', '如何', '怎么', '什么', '哪些', '哪个',
  '实现', '相关', '关于', '进行', '使用', '调用', '涉及', '是否', '有没有',
  'please', 'show', 'find', 'list', 'explain', 'describe', 'implement',
  'code', 'file', 'files', 'function', 'functions', 'method', 'methods',
  'class', 'module', 'project', 'repo', 'repository',
]);

/**
 * Significant tokens for bag-overlap (ASCII identifiers + CJK runs ≥2).
 */
export function exploreQueryTokens(query: string): Set<string> {
  const out = new Set<string>();
  const q = query.trim().toLowerCase();
  if (!q) return out;
  for (const m of q.matchAll(/[a-z][a-z0-9_./:@-]{2,}/g)) {
    const t = m[0]!.replace(/^[@/]+|[/]+$/g, '');
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  for (const m of q.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const t = m[0]!;
    if (!STOP.has(t)) out.add(t);
  }
  return out;
}

/** Jaccard overlap in [0, 1]. */
export function queryTokenJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Bag similarity: max(Jaccard, one-sided containment).
 * Paraphrases often keep the same English seeds while swapping CJK filler —
 * pure Jaccard under-fires on those; containment catches them.
 */
export function queryTokenOverlapScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (inter === 0) return 0;
  const jaccard = inter / (a.size + b.size - inter);
  const containment = Math.max(inter / a.size, inter / b.size);
  return Math.max(jaccard, containment);
}

/**
 * Concrete anchors an agent can put in a tighter follow-up explore.
 * Pure string extraction — no DB.
 */
export function extractRetryAnchorsFromQuery(query: string): string[] {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    anchors.push(t);
  };

  for (const m of query.matchAll(/@kit\.[A-Za-z][\w.]*/g)) add(m[0]!);
  for (const m of query.matchAll(/@ohos\.[A-Za-z][\w.]*/g)) add(m[0]!);
  for (const m of query.matchAll(/\b[A-Za-z_][\w]*\.(?:ets|ts|tsx|js|jsx|cpp|h|hpp|c)\b/g)) add(m[0]!);
  for (const m of query.matchAll(/\b([A-Z][A-Za-z0-9]*(?:[A-Z][a-z0-9]+)+)\b/g)) add(m[1]!);
  for (const m of query.matchAll(/\b([A-Za-z_][\w]*)::([A-Za-z_][\w]*)\b/g)) add(`${m[1]}::${m[2]}`);
  for (const m of query.matchAll(/\b([A-Z][A-Za-z0-9]+)\.([a-z][A-Za-z0-9]*)\b/g)) {
    add(`${m[1]}.${m[2]}`);
  }

  return anchors.slice(0, 8);
}

/** Anchors present in `query` that never appeared in any prior query string. */
export function novelAnchorsVsPriors(query: string, priors: ReadonlyArray<ExploreCallRecord>): string[] {
  const priorBlob = priors.map((c) => c.query).join('\n').toLowerCase();
  return extractRetryAnchorsFromQuery(query).filter((a) => !priorBlob.includes(a.toLowerCase()));
}

export interface ExploreRepeatDecision {
  refuse: boolean;
  /** Matched prior call when refusing for overlap. */
  matched?: ExploreCallRecord;
  reason: 'overlap' | 'call-budget' | 'ok';
}

const OVERLAP_THRESHOLD = 0.5;
/** Successful explores (non-tiny) before a hard "answer now" without new anchors. */
const MAX_SUBSTANTIVE_EXPLORES = 2;

function isSubstantiveCall(call: ExploreCallRecord): boolean {
  // Partials / skips are ~200–400 chars; real explores are multi-kB.
  return (call.responseBytes || 0) >= 800;
}

/**
 * Whether this explore should short-refuse instead of re-running.
 */
export function decideExploreRepeat(
  prior: ExploreProjectState | null | undefined,
  query: string,
): ExploreRepeatDecision {
  if (!prior || prior.calls.length === 0) return { refuse: false, reason: 'ok' };

  const qTokens = exploreQueryTokens(query);
  const substantive = prior.calls.filter(isSubstantiveCall);
  const novel = novelAnchorsVsPriors(query, prior.calls);

  // Hard budget: enough real explores already, and this query adds no new Type/file/@kit.
  if (substantive.length >= MAX_SUBSTANTIVE_EXPLORES && novel.length === 0) {
    return {
      refuse: true,
      matched: substantive[substantive.length - 1],
      reason: 'call-budget',
    };
  }

  // Overlap with any prior substantive explore — unless novel concrete anchors.
  if (novel.length > 0) return { refuse: false, reason: 'ok' };

  let best: ExploreCallRecord | undefined;
  let bestScore = 0;
  for (const call of substantive) {
    const score = queryTokenOverlapScore(qTokens, exploreQueryTokens(call.query));
    if (score > bestScore) {
      bestScore = score;
      best = call;
    }
  }
  if (best && bestScore >= OVERLAP_THRESHOLD) {
    return { refuse: true, matched: best, reason: 'overlap' };
  }

  return { refuse: false, reason: 'ok' };
}

/** Short success-shaped refuse when a repeat explore would waste tokens. */
export function formatExploreRepeatRefuse(
  decision: ExploreRepeatDecision,
  query: string,
): string {
  const priorQ = decision.matched?.query?.trim().slice(0, 100) || '(earlier explore)';
  const files = (decision.matched?.files || []).map((f) => f.path).slice(0, 6);
  const fileLine = files.length > 0
    ? `\nAlready covered files include: ${files.map((f) => `\`${f}\``).join(', ')}.`
    : '';
  const why = decision.reason === 'call-budget'
    ? `This session already ran **${MAX_SUBSTANTIVE_EXPLORES}+** substantive \`homegraph_explore\` calls on this project without a new Type/file/\`@kit\` anchor.`
    : `This query overlaps a prior explore (bag ≈ "${priorQ}${priorQ.length >= 100 ? '…' : ''}").`;

  return [
    '**Skip repeat explore — ANSWER NOW from earlier HomeGraph results in this conversation.**',
    why + fileLine,
    `Current query: "${query.trim().slice(0, 160)}${query.trim().length > 160 ? '…' : ''}"`,
    'Do **not** Grep/Read/node the same symbols/files again — that multiplies tokens.',
    'Only retry \`homegraph_explore\` if you name a **new** concrete Type, file basename, or `@kit`/`@ohos` path that was not in prior queries.',
  ].join('\n');
}

/**
 * Intent phrases that must ride with a bare Type on Partial retry —
 * dropping them collapses data-source / event-dispatch surveys into empty compact.
 */
export function extractRetryIntentHints(query: string): string[] {
  const hints: string[] = [];
  const q = query.trim();
  if (/来源于|数据来源|状态来源|哪个系统服务|data\s+source|which\s+service/i.test(q)) {
    hints.push('数据来源 系统服务');
  }
  if (/分发|分发给|哪些\s*Manager|dispatch|DataShareMgr|事件类型/i.test(q)) {
    hints.push('事件类型 分发 Manager');
  }
  if (/调用链|跨模块|如何驱动|重新计算|multi[- ]?thread|多线程/i.test(q)) {
    hints.push('调用链');
  }
  return hints.slice(0, 2);
}

/**
 * Busy/deadline Partial with actionable anchors from the query (no DB).
 */
export function formatPartialExploreGuidance(opts: {
  seconds: number;
  query?: string;
  why?: string;
}): string {
  const secs = Math.max(1, opts.seconds);
  const why = opts.why
    || `HomeGraph did not finish within ${secs}s (deadline / busy / queue)`;
  const anchors = opts.query ? extractRetryAnchorsFromQuery(opts.query) : [];
  const intents = opts.query ? extractRetryIntentHints(opts.query) : [];
  const retryBits = [
    ...anchors.map((a) => `\`${a}\``),
    ...intents.map((h) => `\`${h}\``),
  ];
  const anchorLine = retryBits.length > 0
    ? `Retry ONE \`homegraph_explore\` with a tighter query using: ${retryBits.join(', ')}.`
      + (intents.length > 0
        ? ' Keep the intent words with the Type — a bare Type alone drops survey routing.'
        : '')
    : 'Retry ONE \`homegraph_explore\` with concrete Type / file basename / `@kit` names from the question (not a broad paraphrase).';

  return [
    `⚠️ **Partial result** — ${why}. This is NOT an error.`,
    anchorLine,
    'Do **not** stack search+explore or node+callers+callees in parallel, and do not Grep/Read symbols you already named (that duplicates tokens).',
    'If the retry still Partials, answer from whatever HomeGraph already returned earlier in this turn — do not open a Grep storm.',
    'HomeGraph is a **locator** (symbols/edges/files). Residual literal / config / unindexed wiring may still need a **narrow** Grep after anchors — not a repo-wide storm.',
  ].join('\n');
}
