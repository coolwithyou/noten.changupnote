import { and, eq, isNull } from "drizzle-orm";
import { isValidBizNoChecksum } from "@cunote/contracts";
import { sanitizeCorpNum } from "@cunote/core";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "../db/client";
import * as schema from "../db/schema";
import type {
  ApplicationAutofillProfile,
  ApplicationAutofillProfileInput,
} from "@/lib/documents/applicationProfileAutofill";

const NAME_MAX = 120;
const EMAIL_MAX = 254;
const PHONE_MAX = 40;
const POSTAL_CODE_MAX = 16;
const ADDRESS_MAX = 300;

export class ApplicationAutofillProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApplicationAutofillProfileError";
  }
}

export async function loadApplicationAutofillProfile(
  access: CompanyAccess,
): Promise<ApplicationAutofillProfile> {
  const db = getCunoteDb();
  return withCunoteDbUser(db, access.userId, async (tx) => {
    const [user] = await tx
      .select({
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.users)
      .where(eq(schema.users.id, access.userId))
      .limit(1);
    const [company] = await tx
      .select({
        name: schema.companies.name,
        businessNumber: schema.companies.bizNo,
        businessNumberVerified: schema.companies.verified,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, access.companyId))
      .limit(1);
    if (!user || !company) {
      throw new ApplicationAutofillProfileError("profile_scope_not_found", "등록정보 대상을 찾지 못했습니다.", 404);
    }
    const [personal] = await tx
      .select()
      .from(schema.userApplicationProfiles)
      .where(eq(schema.userApplicationProfiles.userId, access.userId))
      .limit(1);
    const [companyProfile] = await tx
      .select()
      .from(schema.companyApplicationProfiles)
      .where(eq(schema.companyApplicationProfiles.companyId, access.companyId))
      .limit(1);
    return toProfile({ user, company, personal, companyProfile });
  });
}

export async function saveApplicationAutofillProfile(input: {
  access: CompanyAccess;
  profile: ApplicationAutofillProfileInput;
}): Promise<ApplicationAutofillProfile> {
  const normalized = normalizeApplicationAutofillProfileInput(input.profile);
  const db = getCunoteDb();
  await withCunoteDbUser(db, input.access.userId, async (tx) => {
    const [company] = await tx
      .select({
        name: schema.companies.name,
        bizNo: schema.companies.bizNo,
        verified: schema.companies.verified,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, input.access.companyId))
      .limit(1);
    if (!company) {
      throw new ApplicationAutofillProfileError("company_not_found", "회사 정보를 찾지 못했습니다.", 404);
    }
    if (
      company.verified
      && normalized.company.businessNumber
      && company.bizNo !== normalized.company.businessNumber
    ) {
      throw new ApplicationAutofillProfileError(
        "verified_business_number_conflict",
        "이미 확인된 사업자등록번호와 다른 번호는 여기서 변경할 수 없습니다.",
        409,
        "company.businessNumber",
      );
    }

    const now = new Date();
    await tx
      .insert(schema.userApplicationProfiles)
      .values({
        userId: input.access.userId,
        fullName: normalized.personal.fullName,
        applicationEmail: normalized.personal.applicationEmail,
        phone: normalized.personal.phone,
        postalCode: normalized.personal.postalCode,
        addressLine1: normalized.personal.addressLine1,
        addressLine2: normalized.personal.addressLine2,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.userApplicationProfiles.userId,
        set: {
          fullName: normalized.personal.fullName,
          applicationEmail: normalized.personal.applicationEmail,
          phone: normalized.personal.phone,
          postalCode: normalized.personal.postalCode,
          addressLine1: normalized.personal.addressLine1,
          addressLine2: normalized.personal.addressLine2,
          updatedAt: now,
        },
      });

    await tx
      .insert(schema.companyApplicationProfiles)
      .values({
        companyId: input.access.companyId,
        representativeName: normalized.company.representativeName,
        applicationEmail: normalized.company.applicationEmail,
        phone: normalized.company.phone,
        postalCode: normalized.company.postalCode,
        addressLine1: normalized.company.addressLine1,
        addressLine2: normalized.company.addressLine2,
        updatedBy: input.access.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.companyApplicationProfiles.companyId,
        set: {
          representativeName: normalized.company.representativeName,
          applicationEmail: normalized.company.applicationEmail,
          phone: normalized.company.phone,
          postalCode: normalized.company.postalCode,
          addressLine1: normalized.company.addressLine1,
          addressLine2: normalized.company.addressLine2,
          updatedBy: input.access.userId,
          updatedAt: now,
        },
      });

    const companyValues: Partial<typeof schema.companies.$inferInsert> = {};
    if (normalized.company.name) companyValues.name = normalized.company.name;
    if (normalized.company.businessNumber) {
      companyValues.bizNo = normalized.company.businessNumber;
      if (normalized.company.businessNumber !== company.bizNo) {
        companyValues.verified = false;
        companyValues.verifiedAt = null;
        companyValues.verifyMethod = null;
      }
    }
    if (Object.keys(companyValues).length > 0) {
      const updated = await tx
        .update(schema.companies)
        .set(companyValues)
        .where(and(
          eq(schema.companies.id, input.access.companyId),
          eq(schema.companies.verified, company.verified),
          company.bizNo
            ? eq(schema.companies.bizNo, company.bizNo)
            : isNull(schema.companies.bizNo),
        ))
        .returning({ id: schema.companies.id });
      if (updated.length !== 1) {
        throw new ApplicationAutofillProfileError(
          "company_profile_conflict",
          "회사 정보가 동시에 변경되었습니다. 최신 정보를 다시 확인해 주세요.",
          409,
        );
      }
    }
  });
  return loadApplicationAutofillProfile(input.access);
}

export function normalizeApplicationAutofillProfileInput(
  input: ApplicationAutofillProfileInput,
): ApplicationAutofillProfileInput {
  if (!input || typeof input !== "object" || !input.personal || !input.company) {
    throw new ApplicationAutofillProfileError("invalid_profile", "등록정보 형식이 올바르지 않습니다.", 400);
  }
  const applicationEmail = normalizeEmail(input.personal.applicationEmail, "personal.applicationEmail");
  const companyEmail = normalizeEmail(input.company.applicationEmail, "company.applicationEmail");
  let businessNumber: string | null = null;
  if (cleanOptionalText(input.company.businessNumber, 32, "company.businessNumber")) {
    try {
      businessNumber = sanitizeCorpNum(input.company.businessNumber ?? "");
    } catch {
      throw new ApplicationAutofillProfileError(
        "invalid_business_number",
        "사업자등록번호는 숫자 10자리로 입력해 주세요.",
        400,
        "company.businessNumber",
      );
    }
    if (!isValidBizNoChecksum(businessNumber)) {
      throw new ApplicationAutofillProfileError(
        "invalid_business_number_checksum",
        "사업자등록번호를 다시 확인해 주세요.",
        400,
        "company.businessNumber",
      );
    }
  }
  return {
    personal: {
      fullName: cleanOptionalText(input.personal.fullName, NAME_MAX, "personal.fullName"),
      applicationEmail,
      phone: normalizePhone(input.personal.phone, "personal.phone"),
      postalCode: cleanOptionalText(input.personal.postalCode, POSTAL_CODE_MAX, "personal.postalCode"),
      addressLine1: cleanOptionalText(input.personal.addressLine1, ADDRESS_MAX, "personal.addressLine1"),
      addressLine2: cleanOptionalText(input.personal.addressLine2, ADDRESS_MAX, "personal.addressLine2"),
    },
    company: {
      name: cleanOptionalText(input.company.name, NAME_MAX, "company.name"),
      representativeName: cleanOptionalText(input.company.representativeName, NAME_MAX, "company.representativeName"),
      businessNumber,
      applicationEmail: companyEmail,
      phone: normalizePhone(input.company.phone, "company.phone"),
      postalCode: cleanOptionalText(input.company.postalCode, POSTAL_CODE_MAX, "company.postalCode"),
      addressLine1: cleanOptionalText(input.company.addressLine1, ADDRESS_MAX, "company.addressLine1"),
      addressLine2: cleanOptionalText(input.company.addressLine2, ADDRESS_MAX, "company.addressLine2"),
    },
  };
}

function toProfile(input: {
  user: { name: string | null; email: string };
  company: { name: string | null; businessNumber: string | null; businessNumberVerified: boolean };
  personal: typeof schema.userApplicationProfiles.$inferSelect | undefined;
  companyProfile: typeof schema.companyApplicationProfiles.$inferSelect | undefined;
}): ApplicationAutofillProfile {
  const timestamps = [input.personal?.updatedAt, input.companyProfile?.updatedAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return {
    personal: {
      fullName: input.personal?.fullName ?? input.user.name,
      applicationEmail: input.personal?.applicationEmail ?? input.user.email,
      phone: input.personal?.phone ?? null,
      postalCode: input.personal?.postalCode ?? null,
      addressLine1: input.personal?.addressLine1 ?? null,
      addressLine2: input.personal?.addressLine2 ?? null,
    },
    company: {
      name: input.company.name,
      representativeName: input.companyProfile?.representativeName ?? null,
      businessNumber: input.company.businessNumber,
      businessNumberVerified: input.company.businessNumberVerified,
      applicationEmail: input.companyProfile?.applicationEmail ?? null,
      phone: input.companyProfile?.phone ?? null,
      postalCode: input.companyProfile?.postalCode ?? null,
      addressLine1: input.companyProfile?.addressLine1 ?? null,
      addressLine2: input.companyProfile?.addressLine2 ?? null,
    },
    updatedAt: timestamps[0]?.toISOString() ?? null,
  };
}

function cleanOptionalText(value: unknown, maxLength: number, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new ApplicationAutofillProfileError("invalid_profile_field", "등록정보를 문자열로 입력해 주세요.", 400, field);
  }
  const normalized = value.normalize("NFKC").replace(/[\t\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new ApplicationAutofillProfileError("profile_field_too_long", `입력값은 ${maxLength}자 이하로 입력해 주세요.`, 400, field);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ApplicationAutofillProfileError("invalid_profile_field", "제어 문자를 포함할 수 없습니다.", 400, field);
  }
  return normalized;
}

function normalizeEmail(value: unknown, field: string): string | null {
  const email = cleanOptionalText(value, EMAIL_MAX, field)?.toLocaleLowerCase("en-US") ?? null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new ApplicationAutofillProfileError("invalid_email", "이메일 주소를 다시 확인해 주세요.", 400, field);
  }
  return email;
}

function normalizePhone(value: unknown, field: string): string | null {
  const phone = cleanOptionalText(value, PHONE_MAX, field);
  if (phone && !/^[0-9+()\-\s.]{7,40}$/u.test(phone)) {
    throw new ApplicationAutofillProfileError("invalid_phone", "전화번호를 다시 확인해 주세요.", 400, field);
  }
  return phone;
}
