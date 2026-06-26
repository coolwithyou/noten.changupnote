import { eq } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb, withCunoteDbUser } from "./client";
import * as schema from "./schema";
import {
  DEFAULT_MOCK_USER_ID,
  mockUserEmail,
  mockUserId,
  mockUserName,
} from "../auth/mockIdentity";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

export const DEFAULT_DEMO_COMPANY_ID = "00000000-0000-4000-8000-000000000101";

const dryRun = process.argv.includes("--dry-run");

loadMonorepoEnv();

const seed = buildDemoSeed();

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    ...seed,
  }, null, 2));
} else {
  try {
    const result = await seedDemoData(seed);
    console.log(JSON.stringify({
      dryRun: false,
      ...result,
    }, null, 2));
  } finally {
    await closeCunoteDb();
  }
}

function buildDemoSeed() {
  const userId = mockUserId();
  const companyId = process.env.CUNOTE_DEMO_COMPANY_ID ?? DEFAULT_DEMO_COMPANY_ID;
  assertUuid(userId, "CUNOTE_MOCK_USER_ID");
  assertUuid(companyId, "CUNOTE_DEMO_COMPANY_ID");
  return {
    user: {
      id: userId,
      email: mockUserEmail(),
      name: mockUserName(),
    },
    company: {
      id: companyId,
      name: process.env.CUNOTE_DEMO_COMPANY_NAME ?? "샘플 기업",
    },
    profileRows: demoProfileRows(companyId),
  };
}

async function seedDemoData(input: ReturnType<typeof buildDemoSeed>) {
  const now = new Date();
  await withCunoteDbUser(getCunoteDb(), input.user.id, async (tx) => {
    await tx
      .insert(schema.users)
      .values({
        id: input.user.id,
        email: input.user.email,
        name: input.user.name,
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: {
          email: input.user.email,
          name: input.user.name,
        },
      });

    await tx
      .insert(schema.companies)
      .values({
        id: input.company.id,
        kind: "active",
        name: input.company.name,
        createdBy: input.user.id,
      })
      .onConflictDoUpdate({
        target: schema.companies.id,
        set: {
          kind: "active",
          name: input.company.name,
          createdBy: input.user.id,
        },
      });

    await tx
      .insert(schema.userCompany)
      .values({
        userId: input.user.id,
        companyId: input.company.id,
        role: "owner",
      })
      .onConflictDoUpdate({
        target: [schema.userCompany.userId, schema.userCompany.companyId],
        set: {
          role: "owner",
        },
      });

    await tx.delete(schema.companyProfiles).where(eq(schema.companyProfiles.companyId, input.company.id));
    await tx.insert(schema.companyProfiles).values(
      input.profileRows.map((row) => ({
        ...row,
        asOf: now,
        updatedAt: now,
      })),
    );
  });

  return {
    userId: input.user.id,
    companyId: input.company.id,
    profileRows: input.profileRows.length,
  };
}

function demoProfileRows(companyId: string): Array<Omit<typeof schema.companyProfiles.$inferInsert, "asOf" | "updatedAt">> {
  return [
    {
      companyId,
      dimension: "region",
      value: { code: "41", label: "경기" },
      source: "self_declared",
      confidence: 0.9,
    },
    {
      companyId,
      dimension: "biz_age",
      value: { biz_age_months: 26, months: 26 },
      source: "self_declared",
      confidence: 0.85,
    },
    {
      companyId,
      dimension: "founder_age",
      value: { founder_age: 35, age: 35 },
      source: "self_declared",
      confidence: 0.8,
    },
    {
      companyId,
      dimension: "industry",
      value: { industries: ["ICT", "SW"], tags: ["ICT", "SW"] },
      source: "self_declared",
      confidence: 0.65,
    },
    {
      companyId,
      dimension: "size",
      value: { size: "중소", label: "중소" },
      source: "self_declared",
      confidence: 0.65,
    },
    {
      companyId,
      dimension: "business_status",
      value: { active: true, label: "정상" },
      source: "self_declared",
      confidence: 0.75,
    },
  ];
}

if (String(DEFAULT_MOCK_USER_ID) === String(DEFAULT_DEMO_COMPANY_ID)) {
  throw new Error("Demo user and company ids must differ.");
}

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID for DB-backed development.`);
  }
}
