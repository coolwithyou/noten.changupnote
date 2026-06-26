import type { KStartupAnnouncement } from "@cunote/core";
import type { ServiceRepositories } from "@cunote/core";
import { getCunoteDb } from "@/lib/server/db/client";
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
    return createDrizzleRepositories<KStartupAnnouncement>({
      dialect: "drizzle",
      client: getCunoteDb(),
    });
  }

  return createRuntimeRepositories(loaders);
}

function readAdapterName(): RepositoryAdapterName {
  const value = process.env.CUNOTE_REPOSITORY_ADAPTER?.trim().toLowerCase();
  return value === "drizzle" ? "drizzle" : "runtime";
}
