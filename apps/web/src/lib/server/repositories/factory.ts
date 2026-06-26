import type { KStartupAnnouncement } from "@cunote/core";
import type { ServiceRepositories } from "@cunote/core";
import { createDrizzleRepositories } from "./drizzle";
import {
  createRuntimeRepositories,
  type RuntimeRepositoryLoaders,
} from "./runtime";

export type RepositoryAdapterName = "runtime" | "drizzle";

export function createServiceRepositories(
  loaders: RuntimeRepositoryLoaders<KStartupAnnouncement>,
): ServiceRepositories<KStartupAnnouncement> {
  const adapter = readAdapterName();
  if (adapter === "drizzle") {
    const client = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
    if (!client) {
      throw new Error("DATABASE_URL 또는 SUPABASE_DB_URL 없이 drizzle repository adapter를 사용할 수 없습니다.");
    }
    return createDrizzleRepositories<KStartupAnnouncement>({
      dialect: "drizzle",
      client,
    });
  }

  return createRuntimeRepositories(loaders);
}

function readAdapterName(): RepositoryAdapterName {
  const value = process.env.CUNOTE_REPOSITORY_ADAPTER?.trim().toLowerCase();
  return value === "drizzle" ? "drizzle" : "runtime";
}
