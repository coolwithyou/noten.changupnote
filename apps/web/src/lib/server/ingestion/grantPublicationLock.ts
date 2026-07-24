import { sql } from "drizzle-orm";
import type { CunoteDbSession } from "../db/client";

/**
 * grant criteria/question을 교체하는 모든 publisher가 공유하는 transaction advisory lock.
 * 호출자는 반드시 짧은 DB transaction 안에서 획득하고, lock 이후 baseline을 다시 읽어야 한다.
 */
export async function acquireGrantPublicationLock(
  db: CunoteDbSession,
  grantId: string,
): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`cunote:grant-publication:${grantId}`}))`);
}
