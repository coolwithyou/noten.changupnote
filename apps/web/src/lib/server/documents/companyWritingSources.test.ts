import assert from "node:assert/strict";
import {
  assertCompanyPathScope, buildCompanyWritingSourceRows, companyWritingPdfMetadataSchema, companyWritingSourceBodySchema,
  COMPANY_SOURCES_READ_ONLY_REASON, COMPANY_SOURCES_SESSION_REQUIRED, resolveCompanySourcePermission, writingPdfEncryptionContext,
} from "./companyWritingSources";

const companyId = crypto.randomUUID();
const requestId = crypto.randomUUID();

// 1. 요청 스키마: scope는 받지 않고(strict) 회사 범위로만 저장한다.
const body = { requestId, title: "회사소개서_2026", content: "2025년 매출 3.2억 원.", kind: "company_document", observedDate: "2026-06-30" };
assert.deepEqual(companyWritingSourceBodySchema.parse(body), body);
assert.equal(companyWritingSourceBodySchema.safeParse({ ...body, scope: "application" }).success, false, "scope 필드는 거부");
assert.equal(companyWritingSourceBodySchema.safeParse({ ...body, title: "  " }).success, false, "빈 제목 거부");
assert.equal(companyWritingSourceBodySchema.safeParse({ ...body, content: "x".repeat(30001) }).success, false, "30,000자 초과 거부");
assert.equal(companyWritingSourceBodySchema.safeParse({ ...body, observedDate: "2026-02-30" }).success, false, "존재하지 않는 날짜 거부");
assert.equal(companyWritingSourceBodySchema.safeParse({ ...body, observedDate: null }).success, true, "기준일 미입력 허용");
const metadata = { requestId, title: "회사소개서", observedDate: null, filename: "회사소개서_2026.pdf" };
assert.deepEqual(companyWritingPdfMetadataSchema.parse(metadata), metadata);
assert.equal(companyWritingPdfMetadataSchema.safeParse({ ...metadata, filename: "../x.pdf" }).success, false, "경로 문자 파일명 거부");
assert.equal(companyWritingPdfMetadataSchema.safeParse({ ...metadata, filename: "x.txt" }).success, false, "PDF 확장자만 허용");
assert.equal(companyWritingPdfMetadataSchema.safeParse({ ...metadata, content: "본문" }).success, false, "PDF 요청은 본문을 받지 않음");

// 2. 권한 분기: 멤버 읽기, owner/admin/member 쓰기, viewer 읽기 전용, 데모 거부.
assert.deepEqual(resolveCompanySourcePermission({ role: "owner", mode: "session" }), { canRead: true, canWrite: true, reason: null });
assert.deepEqual(resolveCompanySourcePermission({ role: "admin", mode: "session" }), { canRead: true, canWrite: true, reason: null });
assert.deepEqual(resolveCompanySourcePermission({ role: "member", mode: "token" }), { canRead: true, canWrite: true, reason: null });
assert.deepEqual(resolveCompanySourcePermission({ role: "viewer", mode: "session" }), { canRead: true, canWrite: false, reason: COMPANY_SOURCES_READ_ONLY_REASON });
assert.deepEqual(resolveCompanySourcePermission({ role: "owner", mode: "demo" }), { canRead: false, canWrite: false, reason: COMPANY_SOURCES_SESSION_REQUIRED });

// 3. 경로 companyId와 세션 회사가 다르면 거부(403), 형식이 틀리면 400.
assert.doesNotThrow(() => assertCompanyPathScope(companyId, { companyId }));
assert.throws(() => assertCompanyPathScope(crypto.randomUUID(), { companyId }), (error: unknown) =>
  error instanceof Error && (error as Error & { status: number; code: string }).status === 403 && (error as Error & { code: string }).code === "writing_company_mismatch");
assert.throws(() => assertCompanyPathScope("not-a-uuid", { companyId }), (error: unknown) =>
  error instanceof Error && (error as Error & { status: number }).status === 400);

// 4. 목록 행 조립: 범위·PDF 쪽·사용 중인 문서 수·이번 신청 전용의 문서 정보.
const createdAt = new Date("2026-06-30T00:00:00Z");
const common = { kind: "company_document" as const, contentSha256: "a".repeat(64), observedDate: "2026-06-30", createdAt, withdrawnAt: null,
  draftGrantId: null, documentKey: null, documentName: null, grantTitle: null };
const pdfRow = { ...common, id: "s1", title: "회사소개서_2026.pdf", draftId: null, characters: 8000,
  originalPdf: { storageKey: "k", sha256: "b".repeat(64), bytes: 10, filename: "회사소개서_2026.pdf", pages: 12, keyId: "kid" } };
const textRow = { ...common, id: "s2", title: "2025 결산 요약", draftId: null, kind: "user_statement" as const, observedDate: "2025-12-31", characters: 1840, originalPdf: null };
const withdrawnRow = { ...common, id: "s3", title: "구 브로슈어_2023.pdf", draftId: null, characters: 3, originalPdf: null, withdrawnAt: new Date("2026-07-01T00:00:00Z") };
const applicationRow = { ...common, id: "s4", title: "부산 스케일업 사업계획 메모", draftId: "d1", characters: 620, originalPdf: null,
  draftGrantId: "g1", documentKey: "plan", documentName: "사업계획서", grantTitle: "부산 청년기업 스케일업" };
const rows = buildCompanyWritingSourceRows([pdfRow, textRow, withdrawnRow, applicationRow], new Map([["s1", 2], ["s2", 1], ["ghost", 9]]));
assert.equal(rows.length, 4);
assert.equal(rows[0]!.scope, "company");
assert.deepEqual(rows[0]!.originalPdf, { filename: "회사소개서_2026.pdf", pages: 12, sha256: "b".repeat(64) }, "원본 저장 키·keyId는 직렬화하지 않음");
assert.equal(rows[0]!.usedByDrafts, 2);
assert.equal(rows[0]!.characters, 8000);
assert.equal(rows[0]!.application, null);
assert.equal(rows[1]!.usedByDrafts, 1);
assert.equal(rows[1]!.withdrawn, false);
assert.equal(rows[2]!.withdrawn, true);
assert.equal(rows[2]!.usedByDrafts, 0);
assert.equal(rows[3]!.scope, "application");
assert.deepEqual(rows[3]!.application, { draftId: "d1", grantId: "g1", grantTitle: "부산 청년기업 스케일업", documentKey: "plan", documentName: "사업계획서" });
assert.equal(rows[3]!.createdAt, createdAt.toISOString());
assert.equal(Object.hasOwn(rows[0]!, "storageKey"), false);
assert.equal(Object.hasOwn(rows[0]!.originalPdf!, "storageKey"), false);

// 5. PDF 암호화 문맥: writingPdfSources.ts의 encryptionContext와 같은 형식(회사 범위는 "company").
assert.equal(writingPdfEncryptionContext("c", null, "r", "s"), "cunote-writing-pdf-v1:c:company:r:s");
assert.equal(writingPdfEncryptionContext("c", "d", "r", "s"), "cunote-writing-pdf-v1:c:d:r:s");

console.log("PASS: company writing source schemas reject scope/oversize input; permissions split member read / owner-admin-member write / demo denied; path scope enforced; rows carry usage counts and application links without storage secrets");
