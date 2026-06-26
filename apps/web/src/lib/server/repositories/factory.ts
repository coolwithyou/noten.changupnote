import type { ServiceRepositories } from "@cunote/core";
import { getCunoteDb } from "@/lib/server/db/client";
import { createDrizzleRepositories } from "./drizzle";
import {
  createRuntimeRepositories,
  type RuntimeRepositoryLoaders,
} from "./runtime";

export type RepositoryAdapterName = "runtime" | "drizzle";

export function createServiceRepositories<TPayload = unknown>(
  loaders: RuntimeRepositoryLoaders<TPayload>,
): ServiceRepositories<TPayload> {
  const adapter = getRepositoryAdapterName();
  if (adapter === "drizzle") {
    return createDrizzleRepositories<TPayload>({
      dialect: "drizzle",
      client: getCunoteDb(),
    });
  }

  return createRuntimeRepositories(loaders);
}

export function getRepositoryAdapterName(env: NodeJS.ProcessEnv = process.env): RepositoryAdapterName {
  const value = env.CUNOTE_REPOSITORY_ADAPTER?.trim().toLowerCase();
  return value === "drizzle" ? "drizzle" : "runtime";
}
