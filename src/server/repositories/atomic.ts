import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";

// Internal SQL only. No HTTP handler accepts statements or an actor from request bodies.
export function assertChanged(
  db: D1Database,
  assertionId: string,
): D1PreparedStatement {
  // Must immediately follow the guarded write: the assertion itself changes changes().
  return db
    .prepare(
      "INSERT INTO transaction_assertions(id,ok) VALUES (?, changes()=1)",
    )
    .bind(assertionId);
}

export function assertCafe(
  db: D1Database,
  cafeId: string,
  assertionId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO transaction_assertions(id,ok)
    SELECT ?, EXISTS(SELECT 1 FROM cafes c JOIN datasets d
      ON d.cafe_id=c.id AND d.id=c.active_dataset_id AND d.state='active'
      WHERE c.id=? AND (SELECT COUNT(*) FROM memberships m
        WHERE m.cafe_id=c.id AND m.role='owner' AND m.status='active')=1)`,
    )
    .bind(assertionId, cafeId);
}

export async function atomicCafeBatch(
  db: D1Database,
  cafeId: string,
  statements: D1PreparedStatement[],
  assertionIds: string[] = [],
) {
  const finalId = crypto.randomUUID();
  return db.batch([
    ...statements,
    assertCafe(db, cafeId, finalId),
    ...[...assertionIds, finalId].map((id) =>
      db.prepare("DELETE FROM transaction_assertions WHERE id=?").bind(id),
    ),
  ]);
}
