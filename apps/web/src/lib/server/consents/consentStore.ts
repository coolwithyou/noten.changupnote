import { and, desc, eq, isNull } from "drizzle-orm";
import type { ConsentRecordDto, ConsentScope } from "@cunote/contracts";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface GrantConsentInput {
  companyId: string;
  userId: string;
  scope: ConsentScope;
  purpose?: string | null;
}

export interface RevokeConsentInput {
  companyId: string;
  userId: string;
  scope: ConsentScope;
}

export interface ConsentStore {
  listCompanyConsents(companyId: string, userId: string): Promise<ConsentRecordDto[]>;
  grantConsent(input: GrantConsentInput): Promise<ConsentRecordDto>;
  revokeConsent(input: RevokeConsentInput): Promise<boolean>;
}

const DEFAULT_PURPOSE: Record<ConsentScope, string> = {
  basic_info: "정부지원사업 매칭을 위한 기본 회사정보 처리",
  hometax: "매출·세무 정보 기반 지원사업 자격 확인",
  insurance: "고용·4대보험 정보 기반 지원사업 자격 확인",
};

const memoryConsents = new Map<string, ConsentRecordDto>();

export function getConsentStore(): ConsentStore {
  if (process.env.CUNOTE_REPOSITORY_ADAPTER === "drizzle") return new DrizzleConsentStore();
  return new MemoryConsentStore();
}

class MemoryConsentStore implements ConsentStore {
  async listCompanyConsents(companyId: string, userId: string): Promise<ConsentRecordDto[]> {
    return [...memoryConsents.entries()]
      .filter(([key]) => key.startsWith(`${companyId}:${userId}:`))
      .map(([, value]) => value)
      .sort((a, b) => a.scope.localeCompare(b.scope));
  }

  async grantConsent(input: GrantConsentInput): Promise<ConsentRecordDto> {
    const consent: ConsentRecordDto = {
      scope: input.scope,
      purpose: normalizePurpose(input),
      grantedAt: new Date().toISOString(),
      revokedAt: null,
    };
    memoryConsents.set(consentKey(input.companyId, input.userId, input.scope), consent);
    return consent;
  }

  async revokeConsent(input: RevokeConsentInput): Promise<boolean> {
    const key = consentKey(input.companyId, input.userId, input.scope);
    const current = memoryConsents.get(key);
    if (!current || current.revokedAt) return false;
    memoryConsents.set(key, {
      ...current,
      revokedAt: new Date().toISOString(),
    });
    return true;
  }
}

class DrizzleConsentStore implements ConsentStore {
  async listCompanyConsents(companyId: string, userId: string): Promise<ConsentRecordDto[]> {
    const rows = await withCunoteDbUser(getCunoteDb(), userId, async (db) => db
      .select()
      .from(schema.consents)
      .where(and(eq(schema.consents.companyId, companyId), eq(schema.consents.userId, userId)))
      .orderBy(desc(schema.consents.grantedAt)));

    const latest = new Map<ConsentScope, ConsentRecordDto>();
    for (const row of rows) {
      if (!latest.has(row.scope)) latest.set(row.scope, toConsentDto(row));
    }
    return [...latest.values()].sort((a, b) => a.scope.localeCompare(b.scope));
  }

  async grantConsent(input: GrantConsentInput): Promise<ConsentRecordDto> {
    const now = new Date();
    const [row] = await withCunoteDbUser(getCunoteDb(), input.userId, async (tx) => {
      await tx
        .update(schema.consents)
        .set({ revokedAt: now })
        .where(and(
          eq(schema.consents.companyId, input.companyId),
          eq(schema.consents.userId, input.userId),
          eq(schema.consents.scope, input.scope),
          isNull(schema.consents.revokedAt),
        ));

      return tx
        .insert(schema.consents)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          scope: input.scope,
          purpose: normalizePurpose(input),
          grantedAt: now,
          revokedAt: null,
        })
        .returning();
    });
    if (!row) throw new Error("동의 저장 결과가 없습니다.");
    return toConsentDto(row);
  }

  async revokeConsent(input: RevokeConsentInput): Promise<boolean> {
    const rows = await withCunoteDbUser(getCunoteDb(), input.userId, async (db) => db
      .update(schema.consents)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(schema.consents.companyId, input.companyId),
        eq(schema.consents.userId, input.userId),
        eq(schema.consents.scope, input.scope),
        isNull(schema.consents.revokedAt),
      ))
      .returning({ id: schema.consents.id }));
    return rows.length > 0;
  }
}

export function isConsentScope(value: unknown): value is ConsentScope {
  return value === "basic_info" || value === "hometax" || value === "insurance";
}

function normalizePurpose(input: GrantConsentInput): string {
  const purpose = input.purpose?.trim();
  return purpose || DEFAULT_PURPOSE[input.scope];
}

function toConsentDto(row: typeof schema.consents.$inferSelect): ConsentRecordDto {
  return {
    scope: row.scope,
    purpose: row.purpose,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function consentKey(companyId: string, userId: string, scope: ConsentScope): string {
  return `${companyId}:${userId}:${scope}`;
}
