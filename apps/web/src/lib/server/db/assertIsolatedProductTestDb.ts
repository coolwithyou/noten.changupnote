import { realpathSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { CunoteDb } from "./client";

/** 합성 current evidence 주입은 전달된 DB 자체가 전용 Unix socket cluster일 때만 허용한다. */
export async function assertIsolatedProductTestDb(db: CunoteDb): Promise<void> {
  const socket = process.env.CUNOTE_PRODUCT_TEST_SOCKET ?? "";
  if (!/^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u.test(socket)
      || !/^\/(?:private\/)?tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u.test(realpathSync(socket))) {
    throw new Error("isolated product verification requires dedicated PostgreSQL socket");
  }
  const rows = await db.execute(sql`select inet_server_addr()::text as server_address,
    current_setting('unix_socket_directories') as socket_directories,
    current_database() as database_name, current_user as role_name`) as unknown as Array<{
    server_address: string | null; socket_directories: string;
    database_name: string; role_name: string;
  }>;
  const actualDirectories = rows[0]?.socket_directories.split(",").map((part) => part.trim()) ?? [];
  const expected = realpathSync(socket);
  if (rows.length !== 1 || rows[0]?.server_address !== null
      || rows[0]?.database_name !== "postgres" || rows[0]?.role_name !== "postgres"
      || !actualDirectories.some((part) => {
        try { return realpathSync(part) === expected; } catch { return false; }
      })) {
    throw new Error("isolated product verification DB socket binding failed");
  }
}
