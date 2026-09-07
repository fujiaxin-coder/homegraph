/**
 * Session-level explore repeat / partial guidance (generic).
 *
 * Repeated evidence is deduplicated; lexical overlap alone cannot prove that a
 * follow-up's evidence obligation is already covered. Incomplete retrieval gets
 * one bounded recovery, including when the first response was short or SDK-only.
 *
 * Shape-driven only — no product nouns.
 */

import { mechanismDomainPathTokens } from '../search/query-utils';
import { inferExploreEvidenceStatus } from './explore-session-state';
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

/**
 * Follow-up after the soft budget must be a tight Type/file bag — not another
 * NL paraphrase that merely picks a Type name from a prior inventory.
 */
export function isTightExploreFollowUp(query: string): boolean {
  const anchors = extractRetryAnchorsFromQuery(query);
  if (anchors.length < 1 || anchors.length > 2) return false;
  const tokens = exploreQueryTokens(query);
  return tokens.size <= anchors.length + 3;
}

/** Pull `Next anchor` name from a Partial response body. */
export function extractNextAnchorFromText(text: string): string | undefined {
  const m =
    text.match(/\*\*Next anchor:\*\*[^*\n`]*`([^`]+)`/i)
    || text.match(/Next anchor:\s*`([^`]+)`/i);
  const raw = m?.[1]?.trim();
  if (!raw) return undefined;
  // Prefer the leading identifier if the caption includes kind/path.
  const id = raw.match(/^[A-Za-z_@][\w./:@-]*/)?.[0] ?? raw.split(/\s+/)[0];
  return id?.slice(0, 120);
}

export function inferExplorePartialMeta(text: string): { partial: boolean; nextAnchor?: string } {
  // Compatibility for renderers without structured receipts. A positive
  // completion slogan must never erase a separately reported coverage gap.
  const partial =
    /\*\*Partial locator\*\*|Partial locator|⚠️ \*\*Partial result\*\*|\*\*Partial result\*\*/i.test(text);
  return {
    partial,
    nextAnchor: partial ? extractNextAnchorFromText(text) : undefined,
  };
}

export interface ExploreRepeatDecision {
  refuse: boolean;
  /** Matched prior call when refusing for overlap. */
  matched?: ExploreCallRecord;
  reason: 'overlap' | 'call-budget' | 'hard-cap' | 'next-anchor' | 'ok';
}

/**
 * Absolute retrieval budget per session/project. Empty receipts count as
 * attempts too, so failed recovery cannot create an unbounded retry loop.
 */
const MAX_EXPLORES = 2;

/**
 * After a counted Partial explore, allow this many depth tools
 * (`homegraph_node` / callers / callees) before refusing — stops Partial→node×N
 * compensation without per-question tuning.
 */
const MAX_DEPTH_AFTER_PARTIAL = 1;

function isCountedCall(call: ExploreCallRecord): boolean {
  return call.evidenceStatus !== undefined || (call.responseBytes || 0) >= 400;
}

/**
 * Whether this explore should short-refuse instead of re-running.
 */
export function decideExploreRepeat(
  prior: ExploreProjectState | null | undefined,
  query: string,
): ExploreRepeatDecision {
  if (!prior || prior.calls.length === 0) return { refuse: false, reason: 'ok' };

  const counted = prior.calls.filter(isCountedCall);
  const last = counted[counted.length - 1];

  // Keep the lifetime budget even if bounded state has evicted early receipts.
  if (Math.max(prior.callCount, counted.length) >= MAX_EXPLORES) {
    return {
      refuse: true,
      matched: last,
      reason: 'hard-cap',
    };
  }

  // Missing or SDK-only evidence is not a successfully answered query. Permit
  // its single recovery even if the query overlaps or uses another next anchor.
  if (last && inferExploreEvidenceStatus(last) !== 'complete') {
    return { refuse: false, reason: 'ok' };
  }

  const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const call of counted) {
    if (inferExploreEvidenceStatus(call) !== 'complete') continue;
    // Even the same token bag can reverse a relation ("A calls B" versus
    // "B calls A"). Only an identical normalized request proves repetition.
    if (normalized(query) === normalized(call.query)) {
      return { refuse: true, matched: call, reason: 'overlap' };
    }
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
  const next = decision.matched?.nextAnchor
    ? `\nSuggested **Next anchor:** \`${decision.matched.nextAnchor}\`.`
    : '';

  let why: string;
  switch (decision.reason) {
    case 'hard-cap':
      why = `This session reached its **${MAX_EXPLORES}** \`homegraph_explore\` retrieval attempts on this project, including incomplete attempts.`;
      break;
    case 'next-anchor':
      why = `Prior explore was Partial and named a **Next anchor** — do not re-explore a paraphrase of "${priorQ}${priorQ.length >= 100 ? '…' : ''}".`;
      break;
    case 'call-budget':
      why = `Explore call budget exhausted for this project in the session.`;
      break;
    default:
      why = `This query repeats the same evidence request as "${priorQ}${priorQ.length >= 100 ? '…' : ''}".`;
  }

  return [
    '**Explore retrieval limit — reuse evidence already returned.**',
    why + fileLine + next,
    `Current query: "${query.trim().slice(0, 160)}${query.trim().length > 160 ? '…' : ''}"`,
    'This limit does not mean the task or its evidence is complete. Inspect missing source with a targeted Read or narrow Grep, then continue the requested edits and validation.',
    'Do not repeat the same explore or reread unchanged source already shown; keep any remaining inspection scoped to uncovered evidence.',
  ].join('\n');
}

export interface DepthToolFuseDecision {
  refuse: boolean;
  reason: 'partial-depth-cap' | 'partial-no-callers' | 'ok';
  nextAnchor?: string;
}

/** Latest counted explore call (≥400 response bytes), if any. */
export function latestCountedExplore(
  prior: ExploreProjectState | null | undefined,
): ExploreCallRecord | undefined {
  if (!prior?.calls.length) return undefined;
  for (let i = prior.calls.length - 1; i >= 0; i--) {
    const c = prior.calls[i]!;
    if (isCountedCall(c)) return c;
  }
  return undefined;
}

/**
 * Whether `homegraph_node` / callers / callees should short-refuse after a
 * Partial explore (same failure class as explore×N — depth fan-out).
 *
 * Any one focused depth tool may recover missing evidence. The shared budget
 * prevents fan-out without declaring callers/callees intrinsically invalid.
 */
export function decideDepthToolFuse(
  prior: ExploreProjectState | null | undefined,
  depthCallCount: number,
  _toolName?: string,
): DepthToolFuseDecision {
  const last = latestCountedExplore(prior);
  if (!last || inferExploreEvidenceStatus(last) === 'complete') return { refuse: false, reason: 'ok' };
  const nextAnchor = last.nextAnchor;
  if (depthCallCount >= MAX_DEPTH_AFTER_PARTIAL) {
    return {
      refuse: true,
      reason: 'partial-depth-cap',
      nextAnchor,
    };
  }
  return { refuse: false, reason: 'ok', nextAnchor };
}

/** Success-shaped refuse when Partial already spent its one depth drill. */
export function formatDepthToolRefuse(
  decision: DepthToolFuseDecision,
  toolName: string,
  symbolHint?: string,
): string {
  const next = decision.nextAnchor
    ? `\nSuggested **Next anchor:** \`${decision.nextAnchor}\`.`
    : '';
  const sym = symbolHint?.trim()
    ? `\nRequested: \`${symbolHint.trim().slice(0, 80)}\``
    : '';
  const why = `Prior retrieval was incomplete; this session already used its **${MAX_DEPTH_AFTER_PARTIAL}** `
    + `focused depth recovery call on this project (requested \`${toolName}\`).`;
  return [
    '**Depth recovery budget reached — evidence may still be incomplete.**',
    why + next + sym,
    'Use a targeted Read or narrow Grep for the missing evidence, then continue the requested edits and validation.',
    'Reuse source already shown and avoid repeating the same depth query.',
  ].join('\n');
}

/** Candidate Type for Partial **Next anchor** / digest preference. */
export interface DomainRoleAnchorCandidate {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
}

/**
 * Score a domain Manager/Service for Next-anchor / digest preference.
 * Prefer query-token overlap + *Manager /manager/ paths; demote weak *Utils /
 * *Constants / bare *Subscriber helpers without strong token overlap.
 *
 * `domainTokens` (from {@link mechanismDomainPathTokens}) carries CJK→ASCII
 * stems so NL asks like 通知订阅 rank SubscribeManager over screenlock StateManager.
 */
export function scoreDomainRoleForQuery(
  candidate: DomainRoleAnchorCandidate,
  query: string,
  domainTokens?: readonly string[],
): number {
  const tokens = [...exploreQueryTokens(query)].filter((t) => t.length >= 3);
  const domain = (domainTokens && domainTokens.length > 0
    ? domainTokens
    : mechanismDomainPathTokens(query)
  ).map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
  const name = candidate.name || '';
  const fp = (candidate.filePath || '').toLowerCase().replace(/\\/g, '/');
  const nameLc = name.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (nameLc.includes(t)) score += 12;
    if (fp.includes(`/${t}/`)) score += 10;
    else if (fp.includes(t)) score += 4;
  }
  for (const t of domain) {
    if (nameLc.includes(t)) score += 14;
    if (fp.includes(`/${t}/`)) score += 12;
    else if (fp.includes(t)) score += 5;
  }
  if (/Manager$/i.test(name)) score += 8;
  if (/\/manager\//i.test(fp)) score += 5;
  if (/Service$/i.test(name)) score += 3;
  if (/SubscribeManager|SubscriberManager|EventManager|BridgeManager/i.test(name)) score += 4;
  // Intent-shaped role boosts (shape only — no product nouns beyond domain stems).
  if (/订阅|subscribe/i.test(query)) {
    if (/Subscribe(?:r)?Manager/i.test(name)) score += 22;
    if (/BridgeManager|EventManager/i.test(name) && /notif|subscribe/i.test(nameLc + fp)) score += 8;
    if (/StateManager$/i.test(name) && !/状态|state/i.test(query)) score -= 18;
    if (/screenlock|keyguard/i.test(fp) && !/锁屏|screenlock|keyguard/i.test(query)) score -= 14;
  }
  if (/备份|恢复|backup|restore/i.test(query)) {
    if (/Extension$/i.test(name) || /ExtensionAbility/i.test(name)) score += 22;
    if (/BackupLauncher|RestoreLauncher|DataRestore|Controller$/i.test(name)) score += 12;
    if (/EventManager$/i.test(name) && !/Extension/i.test(name)) score -= 6;
  }
  // Pipeline verbs (parse/install/activate/download): prefer matching Types,
  // demote antithetical Delete/Remove/Uninstall names that share a domain stem.
  if (/(?:解析|安装|激活|下载|parse|install|activate|download)/i.test(query)) {
    if (/Activate|Installer|PackParser|PackageInstall|ThemePack/i.test(name)) score += 14;
    if (/^(?:Delete|Remove|Uninstall|Clear|Cancel)/i.test(name)
      || /Delete|Uninstall|RemoveOnline|CancelRestore/i.test(name)) {
      score -= 36;
    }
  }
  // Weak helpers: only keep if they already scored on tokens.
  if (/(Utils|Constants|Info|Entry|Helper)$/i.test(name)) score -= 8;
  if (/Subscriber$/i.test(name) && !/Manager/i.test(name) && score < 16) score -= 6;
  if (/Listener$/i.test(name) && !/Manager/i.test(name) && score < 16) score -= 4;
  return score;
}

/** Best domain-role Type for Next anchor, or undefined when inventory empty. */
export function pickBestDomainRoleAnchor(
  candidates: ReadonlyArray<DomainRoleAnchorCandidate>,
  query: string,
  domainTokens?: readonly string[],
): DomainRoleAnchorCandidate | undefined {
  if (!candidates.length) return undefined;
  let best: DomainRoleAnchorCandidate | undefined;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (!c?.name) continue;
    const s = scoreDomainRoleForQuery(c, query, domainTokens);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/** Format Next anchor caption used in Partial / soft-close footers. */
export function formatNextAnchorCaption(c: DomainRoleAnchorCandidate): string {
  const line = c.startLine && c.startLine > 0 ? String(c.startLine) : '?';
  return `\`${c.name}\` (${c.kind}) — \`${c.filePath.replace(/\\/g, '/')}:${line}\``;
}

/**
 * Coarse retrieval banner: source reuse is separate from task completion.
 */
export function formatMechanismSoftCloseHeader(): string {
  return (
    '> **Coarse source evidence below.** '
    + 'Reuse the source shown for these symbols. '
    + 'Check relevance and uncovered wiring before continuing the requested edits or explanation.'
  );
}

/**
 * Coarse retrieval footer; never claims that an inventory completes the task.
 */
export function formatMechanismSoftCloseFooter(next?: DomainRoleAnchorCandidate): string {
  const hint = next
    ? ` Primary Type: \`${next.name}\`.`
    : '';
  return (
    '> **Coarse source evidence returned.**'
    + hint
    + ' Retrieval is not task completion. Reuse the displayed source; inspect uncovered code '
    + 'with one focused follow-up or targeted Read/Grep, then continue authorized edits and checks.'
  );
}

/** Honest Partial footer with a single Next anchor + ONE Grep. */
export function formatMechanismPartialFooter(nextCaption: string): string {
  return (
    '> **Partial locator** — not a full mechanism closure. '
    + `**Next anchor:** ${nextCaption}. `
    + 'One focused recovery may use this anchor or a different uncovered part of the task. '
    + 'Use targeted Read/Grep if the evidence remains missing; an inventory alone does not establish behavior.'
  );
}

/**
 * Appended when a second counted Partial is emitted in the same session —
 * stop HomeGraph; do not take a third explore.
 */
export function formatSecondPartialStopFooter(nextAnchor?: string): string {
  const next = nextAnchor
    ? `\nPrior **Next anchor:** \`${nextAnchor}\`.`
    : '';
  return [
    '',
    '---',
    '> **Second Partial — explore retrieval budget reached.** Do not repeat `homegraph_explore`.'
    + next
    + ' Evidence remains incomplete. Inspect only missing source with targeted Read or narrow Grep, '
    + 'then continue the requested edits and validation. Reuse unchanged source already returned.',
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
    ? `If you retry, ONE tight \`homegraph_explore\` using only: ${retryBits.join(', ')} `
      + '(not a paraphrase of the whole question).'
      + (intents.length > 0
        ? ' Keep the intent words with the Type.'
        : '')
    : 'If you retry, ONE tight \`homegraph_explore\` with a single Type / file / `@kit` name — not a broad paraphrase.';

  return [
    `⚠️ **Partial result** — ${why}. This is NOT an error.`,
    'A targeted Read or **ONE narrow Grep** may recover missing evidence using names already in the question.',
    anchorLine,
    'At most **one** focused `homegraph_node` or callers/callees recovery after Partial; reuse source already returned.',
    'If a second explore is still Partial, its retrieval budget is exhausted. Inspect missing source directly and continue the requested work; do not infer task completion.',
  ].join('\n');
}
