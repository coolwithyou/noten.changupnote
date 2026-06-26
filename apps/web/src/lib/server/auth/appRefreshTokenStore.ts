import { and, eq, isNull } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface StoredRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  deviceId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedFrom: string | null;
  createdAt: Date;
}

export interface SaveRefreshTokenInput {
  id: string;
  userId: string;
  tokenHash: string;
  deviceId: string;
  expiresAt: Date;
  rotatedFrom?: string | null;
}

export interface AppRefreshTokenStore {
  save(input: SaveRefreshTokenInput): Promise<StoredRefreshToken>;
  findActiveByHash(tokenHash: string): Promise<StoredRefreshToken | null>;
  revoke(id: string): Promise<void>;
  revokeDevice(userId: string, deviceId: string): Promise<void>;
}

const memoryStore = new Map<string, StoredRefreshToken>();

export function getAppRefreshTokenStore(): AppRefreshTokenStore {
  if (process.env.CUNOTE_REPOSITORY_ADAPTER === "drizzle") return new DrizzleRefreshTokenStore();
  return new MemoryRefreshTokenStore();
}

class MemoryRefreshTokenStore implements AppRefreshTokenStore {
  async save(input: SaveRefreshTokenInput): Promise<StoredRefreshToken> {
    const row: StoredRefreshToken = {
      ...input,
      rotatedFrom: input.rotatedFrom ?? null,
      revokedAt: null,
      createdAt: new Date(),
    };
    memoryStore.set(row.tokenHash, row);
    return row;
  }

  async findActiveByHash(tokenHash: string): Promise<StoredRefreshToken | null> {
    const row = memoryStore.get(tokenHash);
    if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
    return row;
  }

  async revoke(id: string): Promise<void> {
    for (const [hash, row] of memoryStore.entries()) {
      if (row.id === id) memoryStore.set(hash, { ...row, revokedAt: new Date() });
    }
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    for (const [hash, row] of memoryStore.entries()) {
      if (row.userId === userId && row.deviceId === deviceId && !row.revokedAt) {
        memoryStore.set(hash, { ...row, revokedAt: new Date() });
      }
    }
  }
}

class DrizzleRefreshTokenStore implements AppRefreshTokenStore {
  async save(input: SaveRefreshTokenInput): Promise<StoredRefreshToken> {
    const [row] = await getCunoteDb()
      .insert(schema.appRefreshTokens)
      .values({
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        deviceId: input.deviceId,
        expiresAt: input.expiresAt,
        rotatedFrom: input.rotatedFrom ?? null,
      })
      .returning();
    if (!row) throw new Error("refresh token 저장 결과가 없습니다.");
    return toStored(row);
  }

  async findActiveByHash(tokenHash: string): Promise<StoredRefreshToken | null> {
    const [row] = await getCunoteDb()
      .select()
      .from(schema.appRefreshTokens)
      .where(and(
        eq(schema.appRefreshTokens.tokenHash, tokenHash),
        isNull(schema.appRefreshTokens.revokedAt),
      ))
      .limit(1);
    if (!row || row.expiresAt <= new Date()) return null;
    return toStored(row);
  }

  async revoke(id: string): Promise<void> {
    await getCunoteDb()
      .update(schema.appRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.appRefreshTokens.id, id));
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    await getCunoteDb()
      .update(schema.appRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(schema.appRefreshTokens.userId, userId),
        eq(schema.appRefreshTokens.deviceId, deviceId),
        isNull(schema.appRefreshTokens.revokedAt),
      ));
  }
}

function toStored(row: typeof schema.appRefreshTokens.$inferSelect): StoredRefreshToken {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    deviceId: row.deviceId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    rotatedFrom: row.rotatedFrom,
    createdAt: row.createdAt,
  };
}
