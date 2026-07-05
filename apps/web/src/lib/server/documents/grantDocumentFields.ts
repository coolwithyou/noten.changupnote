import { asc, eq } from "drizzle-orm";
import type {
  DocumentField,
  DocumentFieldType,
  DocumentFillStrategy,
  GrantDocumentCategory,
  GrantDocumentFormField,
} from "@cunote/contracts";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "../db/client";
import * as schema from "../db/schema";

export type { GrantDocumentFormField } from "@cunote/contracts";

const FIELD_TYPES: DocumentFieldType[] = [
  "text",
  "long_text",
  "number",
  "date",
  "currency",
  "checkbox",
  "table",
  "file",
  "unknown",
];
const FILL_STRATEGIES: DocumentFillStrategy[] = ["copy", "summarize", "generate", "ask_user", "manual"];

export async function listGrantDocumentFormFields(input: {
  grantId: string;
  access: CompanyAccess;
  limit?: number;
}): Promise<GrantDocumentFormField[]> {
  if (!isUuid(input.grantId) || !hasDatabaseUrl()) return [];

  const limit = Math.min(Math.max(input.limit ?? 80, 1), 200);
  try {
    const rows = await withCunoteDbUser(getCunoteDb(), input.access.userId, async (tx) => tx
      .select({
        documentCategory: schema.grantDocumentFields.documentCategory,
        documentName: schema.grantDocumentFields.documentName,
        sourceAttachment: schema.grantDocumentFields.sourceAttachment,
        fieldKey: schema.grantDocumentFields.fieldKey,
        label: schema.grantDocumentFields.label,
        section: schema.grantDocumentFields.section,
        fieldType: schema.grantDocumentFields.fieldType,
        required: schema.grantDocumentFields.required,
        sourceSpan: schema.grantDocumentFields.sourceSpan,
        mappedCompanyField: schema.grantDocumentFields.mappedCompanyField,
        fillStrategy: schema.grantDocumentFields.fillStrategy,
        confidence: schema.grantDocumentFields.confidence,
        parserVersion: schema.grantDocumentFields.parserVersion,
      })
      .from(schema.grantDocumentFields)
      .where(eq(schema.grantDocumentFields.grantId, input.grantId))
      .orderBy(
        asc(schema.grantDocumentFields.sourceAttachment),
        asc(schema.grantDocumentFields.documentName),
        asc(schema.grantDocumentFields.section),
        asc(schema.grantDocumentFields.fieldKey),
      )
      .limit(limit));
    return rows.map(toGrantDocumentFormField);
  } catch (error) {
    console.warn(`Grant document field mapping lookup failed: ${errorMessage(error)}`);
    return [];
  }
}

function toGrantDocumentFormField(row: {
  documentCategory: string;
  documentName: string;
  sourceAttachment: string | null;
  fieldKey: string;
  label: string;
  section: string | null;
  fieldType: string;
  required: boolean;
  sourceSpan: string | null;
  mappedCompanyField: string | null;
  fillStrategy: string;
  confidence: number;
  parserVersion: string;
}): GrantDocumentFormField {
  return {
    documentName: row.documentName,
    documentCategory: toDocumentCategory(row.documentCategory),
    fieldKey: row.fieldKey,
    label: row.label,
    section: row.section,
    fieldType: toFieldType(row.fieldType),
    required: row.required,
    sourceSpan: row.sourceSpan,
    sourceAttachment: row.sourceAttachment,
    mappedCompanyField: row.mappedCompanyField,
    fillStrategy: toFillStrategy(row.fillStrategy),
    confidence: row.confidence,
    parserVersion: row.parserVersion,
  };
}

function toDocumentCategory(value: string): GrantDocumentCategory | "other" {
  const categories: Array<GrantDocumentCategory | "other"> = [
    "application_form",
    "business_plan",
    "proposal_or_intro",
    "consent_or_pledge",
    "business_registration",
    "corporate_register",
    "company_confirmation",
    "financial_tax",
    "employment_insurance",
    "shareholder",
    "bank_account",
    "estimate_budget",
    "portfolio_catalog",
    "ip_certification",
    "recommendation",
    "performance_evidence",
    "other",
  ];
  return categories.includes(value as GrantDocumentCategory | "other")
    ? value as GrantDocumentCategory | "other"
    : "other";
}

function toFieldType(value: string): DocumentFieldType {
  return FIELD_TYPES.includes(value as DocumentFieldType) ? value as DocumentFieldType : "unknown";
}

function toFillStrategy(value: string): DocumentFillStrategy {
  return FILL_STRATEGIES.includes(value as DocumentFillStrategy) ? value as DocumentFillStrategy : "manual";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
