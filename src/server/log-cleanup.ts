import type { AppDatabase } from "./db";

export function cleanupOldRequests(db: AppDatabase, retentionDays: number): { deletedRequests: number; deletedBodies: number } {
  const days = Math.max(1, Math.floor(retentionDays));
  const bodiesBefore = Number((db.prepare("SELECT COUNT(*) AS value FROM request_bodies").get() as { value: number }).value);
  const result = db.prepare("DELETE FROM gateway_requests WHERE julianday('now') - julianday(started_at) > ?").run(days);
  const bodiesAfter = Number((db.prepare("SELECT COUNT(*) AS value FROM request_bodies").get() as { value: number }).value);
  return { deletedRequests: result.changes, deletedBodies: Math.max(0, bodiesBefore - bodiesAfter) };
}

export function stripAllBodies(db: AppDatabase): { stripped: number } {
  const result = db.prepare("DELETE FROM request_bodies").run();
  return { stripped: result.changes };
}
