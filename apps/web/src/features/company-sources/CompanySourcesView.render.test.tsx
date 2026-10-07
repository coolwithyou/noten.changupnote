import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompanyWritingSourceRow, CompanyWritingSources } from "@/lib/server/documents/companyWritingSources";
import { CompanySourcesView } from "./CompanySourcesView";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const companyId = "11111111-1111-4111-8111-111111111111";
const row = (patch: Partial<CompanyWritingSourceRow> & Pick<CompanyWritingSourceRow, "id" | "title">): CompanyWritingSourceRow => ({
  scope: "company", kind: "company_document", sha256: "a".repeat(64), observedDate: "2026-06-30", createdAt: "2026-06-30T00:00:00.000Z",
  withdrawn: false, characters: 8000, usedByDrafts: 2, application: null, ...patch,
});
const sceneA: CompanyWritingSources = {
  companyId, sourcesTruncated: false, canWrite: true, canUploadPdf: true, readOnlyReason: null,
  sources: [
    row({ id: "r1", title: "회사소개서_2026.pdf", originalPdf: { filename: "회사소개서_2026.pdf", pages: 12, sha256: "b".repeat(64) } }),
    row({ id: "r2", title: "2025 결산 요약(직접 입력)", kind: "user_statement", observedDate: "2025-12-31", characters: 1840, usedByDrafts: 1 }),
    row({ id: "r4", title: "부산 스케일업 사업계획 메모", scope: "application", kind: "user_statement", observedDate: "2026-09-28", characters: 620, usedByDrafts: 0,
      application: { draftId: "d1", grantId: "g1", grantTitle: "부산 청년기업 스케일업", documentKey: "plan", documentName: "사업계획서" } }),
  ],
};

const htmlA = renderToStaticMarkup(<CompanySourcesView companyId={companyId} initial={sceneA} loadError={null} />);
for (const text of ["회사 자료", "다른 공고에서도 재사용하는 회사 공통 자료예요", "자료는 확인 전 회사 사실로 확정하지 않아요",
  "자료 목록", "회사 공통 자료 2 · 이번 신청 전용 1", "2026-06-30 기준 · PDF 12쪽 · 사용 중인 문서 2건", "2025-12-31 기준 · 텍스트 1,840자 · 사용 중인 문서 1건",
  "부산 청년기업 스케일업 · 2026-09-28 기준 · 텍스트 620자", "사용 가능", "읽을 수 있다는 뜻이며 사실을 인증한 상태가 아니에요",
  "기존 회사 문서에서 가져온 내용이에요", "이번 신청 전용 자료는 해당 문서의 작성 화면에서 관리해요", "작성 화면 열기",
  "/grants/g1/workspace?document=plan&amp;companyId=11111111-1111-4111-8111-111111111111",
  "내용 보기", "PDF 원본", "자료 사용 중단", "자료 추가", "PDF 파일과 자료 내용 중 하나만 채워요", "예: 회사소개서_2026",
  "최대 4MB·30쪽·추출 텍스트 30,000자. 스캔·암호 PDF는 지원하지 않아요.", "PDF 대신 내용을 직접 붙여 넣을 수 있어요 · 최대 30,000자",
  "자료 기준일 · 선택", "다른 공고에서도 사용할 회사 공통 자료로 저장", "자료 저장", "추출 후 표와 숫자의 읽기 순서를 확인하고 자료로 선택해 주세요.",
  "저장된 회사 사실(상호·소재지·업종·업력)은 기존 회사 프로필에서 관리해요"]) {
  assert.ok(htmlA.includes(text), `장면 A 문구 누락: ${text}`);
}
assert.equal(htmlA.split("자료 사용 중단").length - 1, 2, "회사 공통 자료 2건에만 사용 중단 버튼 (이번 신청 전용 제외)");
assert.equal(htmlA.split("PDF 원본").length - 1, 1, "PDF 원본이 있는 행에만 다운로드 버튼");
assert.doesNotMatch(htmlA.replace(/<[^>]+>/g, " "), /지원 가능|매칭률|선정 확률|\d+%/, "보이는 문구에 금지 어휘·백분율 없음");

const sceneB: CompanyWritingSources = { ...sceneA, sources: [...sceneA.sources,
  row({ id: "r5", title: "구 브로슈어_2023.pdf", observedDate: "2023-06-30", withdrawn: true, usedByDrafts: 0, originalPdf: { filename: "구 브로슈어_2023.pdf", pages: 8, sha256: "c".repeat(64) } })] };
const htmlB = renderToStaticMarkup(<CompanySourcesView companyId={companyId} initial={sceneB} loadError={null} />);
assert.ok(htmlB.includes("사용 중단됨"));
assert.ok(htmlB.includes("2023-06-30 기준 · PDF 8쪽 · 사용 중인 문서 0건"));
assert.equal(htmlB.split("자료 사용 중단").length - 1, 2, "사용 중단된 행에는 중단 버튼 없음");
assert.equal(htmlB.split("PDF 원본").length - 1, 2, "사용 중단된 PDF 원본도 내려받기 가능");
assert.equal(htmlB.includes("다시 사용"), false, "DB 불변 트리거상 되돌리기 없음");

const sceneC: CompanyWritingSources = { ...sceneA, sources: [] };
const htmlC = renderToStaticMarkup(<CompanySourcesView companyId={companyId} initial={sceneC} loadError={null} />);
assert.ok(htmlC.includes("저장한 자료가 없어요."));
assert.ok(htmlC.includes("아래에서 첫 자료를 추가해 주세요."));
assert.equal(htmlC.includes("자료 목록"), false);

const readOnly: CompanyWritingSources = { ...sceneA, canWrite: false, canUploadPdf: false, readOnlyReason: "읽기 권한으로 열었어요. 자료를 추가하거나 사용 중단할 수 없어요." };
const htmlR = renderToStaticMarkup(<CompanySourcesView companyId={companyId} initial={readOnly} loadError={null} />);
assert.ok(htmlR.includes("읽기 권한으로 열었어요. 자료를 추가하거나 사용 중단할 수 없어요."));
const saveIndex = htmlR.indexOf(">자료 저장<");
assert.ok(saveIndex > 0);
const saveButtonStart = htmlR.lastIndexOf('data-slot="button"', saveIndex);
assert.ok(saveButtonStart >= 0 && htmlR.slice(saveButtonStart, saveIndex).includes("disabled"), "읽기 전용이면 저장 버튼 비활성");

const htmlE = renderToStaticMarkup(<CompanySourcesView companyId={companyId} initial={null} loadError="회사 자료를 보려면 로그인해 주세요." />);
assert.ok(htmlE.includes("회사 자료를 불러오지 못했어요."));
assert.ok(htmlE.includes("회사 자료를 보려면 로그인해 주세요."));
assert.ok(htmlE.includes("다시 불러오기"));

console.log("PASS: company sources view renders design scenes A/B/C with exact vocabulary, scopes actions by source scope/withdrawal, and disables writes for read-only access");
