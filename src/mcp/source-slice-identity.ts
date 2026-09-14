import { createHash } from 'node:crypto';

/** 只标识实际返回的片段，不冒充整个文件版本或任务覆盖率。 */
export function sourceSliceIdentity(path: string, start: number, source: string): string {
  const end = start + source.split('\n').length - 1;
  const digest = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16);
  return `Source slice: ${path}:${start}-${end}; excerpt-sha256=${digest}. Excerpt only; refresh after edits.`;
}
