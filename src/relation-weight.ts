/**
 * Relation weights are bounded to [0, 1] (62.1 D7, CM-19).
 *
 * `insertRelation` used to upsert `weight = weight + excluded.weight`, so a pair re-recorded on every Stop grew
 * without bound (a live vault held usage edges near 9,000). Writers now clamp their input and keep the larger of
 * the stored and the new weight; every reader clamps on read as well, because rows written before the fix keep
 * their inflated values until the counter repair rebuilds them.
 */

/** The bounded weight a writer may store: non-finite → 1.0, below 0 → 0, above 1 → 1. */
export function clampRelationWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 1.0;
  if (weight < 0) return 0;
  if (weight > 1) return 1;
  return weight;
}

/**
 * SQL for a relation row's weight as readers must see it: NULL → 0, clamped to [0, 1]. Use it in the SELECT list
 * AND in any ORDER BY, so ranking and scoring read the same bounded value.
 */
export function relWeightSql(alias: string): string {
  return `MIN(1.0, MAX(0.0, COALESCE(${alias}.weight, 0.0)))`;
}
