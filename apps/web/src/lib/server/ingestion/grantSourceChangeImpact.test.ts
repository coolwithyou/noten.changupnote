import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGrantSourceChangeImpact,
  parseGrantSourceChangeImpact,
  type GrantSourceChangeProjectionInput,
} from "./grantSourceChangeImpact";

function projection(overrides: Partial<GrantSourceChangeProjectionInput> = {}): GrantSourceChangeProjectionInput {
  return {
    source: "kstartup",
    rawPayload: {
      biz_pbanc_nm: "테스트 공고",
      aply_trgt_ctnt: "서울 소재 창업기업",
      aply_excl_trgt_ctnt: "휴폐업 기업 제외",
      pbanc_rcpt_bgng_dt: "2026-09-01",
      pbanc_rcpt_end_dt: "2026-09-30",
      inqireCo: 10,
    },
    recruitment: { applyStart: "2026-09-01", applyEnd: "2026-09-30", status: "open" },
    eligibility: [{ dimension: "region", value: "서울" }],
    attachments: [],
    extractorContract: { parserVersion: "v1" },
    ...overrides,
  };
}

test("조회수 같은 관측 메타데이터 변경은 증거 재결속만 요구한다", () => {
  const previous = projection();
  const current = projection({ rawPayload: { ...previous.rawPayload as object, inqireCo: 11 } });
  const actual = classifyGrantSourceChangeImpact({ previous, current });
  assert.equal(actual.classification, "evidence_refresh");
  assert.deepEqual(actual.changedDomains, ["raw"]);
  assert.equal(actual.requiresModelRun, false);
});

test("접수 기간만 바뀌면 eligibility를 재사용하고 모집 상태만 갱신한다", () => {
  const previous = projection();
  const current = projection({
    rawPayload: { ...previous.rawPayload as object, pbanc_rcpt_end_dt: "2026-10-10" },
    recruitment: { applyStart: "2026-09-01", applyEnd: "2026-10-10", status: "open" },
  });
  const actual = classifyGrantSourceChangeImpact({ previous, current });
  assert.equal(actual.classification, "recruitment_only");
  assert.deepEqual(actual.changedDomains, ["raw", "recruitment"]);
});

test("새 제외 조항과 참조 첨부는 coverage 검토를 요구한다", () => {
  const previous = projection();
  const exclusion = classifyGrantSourceChangeImpact({
    previous,
    current: projection({
      rawPayload: { ...previous.rawPayload as object, aply_excl_trgt_ctnt: "휴폐업·세금 체납 기업 제외" },
    }),
  });
  assert.equal(exclusion.classification, "coverage_review_required");
  assert.ok(exclusion.changedDomains.includes("coverage"));

  const attachment = classifyGrantSourceChangeImpact({
    previous,
    current: projection({ attachments: [{ filename: "추가 자격요건.hwp", sha256: "a".repeat(64) }] }),
  });
  assert.equal(attachment.classification, "coverage_review_required");
  assert.ok(attachment.changedDomains.includes("attachments"));
});

test("조건 projection과 추출 계약 변경은 조건 검토에서 재개한다", () => {
  const previous = projection();
  assert.equal(classifyGrantSourceChangeImpact({
    previous,
    current: projection({ eligibility: [{ dimension: "region", value: "경기" }] }),
  }).classification, "condition_review_required");
  assert.equal(classifyGrantSourceChangeImpact({
    previous,
    current: projection({ extractorContract: { parserVersion: "v2" } }),
  }).classification, "condition_review_required");
});

test("동일 입력은 멱등이며 알 수 없는 수집원 raw 변경은 자동 재사용하지 않는다", () => {
  const current = projection();
  const first = classifyGrantSourceChangeImpact({ previous: current, current });
  const second = classifyGrantSourceChangeImpact({ previous: current, current });
  assert.deepEqual(first, second);
  assert.equal(first.classification, "unchanged");
  assert.deepEqual(parseGrantSourceChangeImpact(first), first);

  const unknownPrevious = projection({ source: "external", rawPayload: { body: "이전" } });
  const unknown = classifyGrantSourceChangeImpact({
    previous: unknownPrevious,
    current: projection({ source: "external", rawPayload: { body: "현재" } }),
  });
  assert.equal(unknown.classification, "unknown_review_required");
});
