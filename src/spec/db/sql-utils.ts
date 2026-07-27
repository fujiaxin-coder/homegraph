/**
 * Shared SQL helpers for the spec db layer.
 *
 * @module spec/db/sql-utils
 */

/**
 * Escape LIKE metacharacters (`%`, `_`) and the escape character itself so
 * the input is matched literally in `LIKE ... ESCAPE '\'` queries.
 */
export function escapeLike(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}
