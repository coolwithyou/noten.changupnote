import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { CunoteDb } from "../db/client";

const SCOPE = "current_inventory";
// The Vercel function is capped at 300s and each remote call at 30s.
// A killed invocation releases its claim after this bounded recovery window.

export interface ConversionSweepLease {
  owner: string;
}

/** Atomic cross-instance claim; no database connection remains held during remote conversion. */
export async function claimConversionSweepLease(db: CunoteDb): Promise<ConversionSweepLease | null> {
  const owner = randomUUID();
  const rows = await db.execute(sql`
    INSERT INTO conversion_sweep_leases (scope, owner, expires_at, updated_at)
    VALUES (${SCOPE}, ${owner}::uuid, now() + interval '10 minutes', now())
    ON CONFLICT (scope) DO UPDATE SET
      owner = EXCLUDED.owner,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
    WHERE conversion_sweep_leases.expires_at <= now()
    RETURNING owner
  `);
  return rows.length === 1 ? { owner } : null;
}

/** Owner-fenced release; an expired runner cannot clear a successor claim. */
export async function releaseConversionSweepLease(db: CunoteDb, lease: ConversionSweepLease): Promise<boolean> {
  const rows = await db.execute(sql`
    UPDATE conversion_sweep_leases
    SET expires_at = now(), updated_at = now()
    WHERE scope = ${SCOPE} AND owner = ${lease.owner}::uuid
    RETURNING owner
  `);
  return rows.length === 1;
}
