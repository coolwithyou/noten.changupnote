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

test("기업마당 조회수 관측값 변경은 증거 재결속만 요구한다", () => {
  const previous = projection({ source: "bizinfo", rawPayload: { trgetNm: "서울 소재 창업기업", inqireCo: 10 } });
  const current = projection({ source: "bizinfo", rawPayload: { trgetNm: "서울 소재 창업기업", inqireCo: 11 } });
  const actual = classifyGrantSourceChangeImpact({ previous, current });
  assert.equal(actual.classification, "evidence_refresh");
  assert.deepEqual(actual.changedDomains, ["raw"]);
  assert.equal(actual.requiresModelRun, false);
});

test("K-Startup의 알 수 없는 필드는 조회수와 닮아도 검수한다", () => {
  const previous = projection();
  const current = projection({ rawPayload: { ...previous.rawPayload as object, inqireCo: 11 } });
  assert.equal(classifyGrantSourceChangeImpact({ previous, current }).classification, "coverage_review_required");
});

test("접수 기간 raw 문구가 바뀌면 모집 projection과 함께 검수한다", () => {
  const previous = projection();
  const current = projection({
    rawPayload: { ...previous.rawPayload as object, pbanc_rcpt_end_dt: "2026-10-10" },
    recruitment: { applyStart: "2026-09-01", applyEnd: "2026-10-10", status: "open" },
  });
  const actual = classifyGrantSourceChangeImpact({ previous, current });
  assert.equal(actual.classification, "coverage_review_required");
  assert.deepEqual(actual.changedDomains, ["raw", "recruitment", "coverage"]);
});

test("원문 의미가 같고 모집 상태만 종료되면 모집 현행성 갱신으로 한정한다", () => {
  const previous = projection();
  const actual = classifyGrantSourceChangeImpact({
    previous,
    current: projection({ recruitment: {
      applyStart: "2026-09-01", applyEnd: "2026-09-30", status: "closed",
    } }),
  });
  assert.equal(actual.classification, "recruitment_only");
  assert.deepEqual(actual.changedDomains, ["recruitment"]);
  assert.equal(actual.requiresModelRun, false);
});

test("raw에 새 의미 필드가 생기면 기존 coverage 목록 밖이어도 검수한다", () => {
  const previous = projection();
  const current = projection({ rawPayload: {
    ...previous.rawPayload as object,
    new_eligibility_clause: "최근 지원 이력 제외",
  } });
  const actual = classifyGrantSourceChangeImpact({ previous, current });
  assert.equal(actual.classification, "coverage_review_required");
  assert.ok(actual.changedDomains.includes("coverage"));
});

test("detail 관측 시각만 바뀌면 의미 불변이다", () => {
  const previous = projection({ rawPayload: { detail: { fetched_at: "2026-09-01", text: "동일" } } });
  const current = projection({ rawPayload: { detail: { fetched_at: "2026-09-02", text: "동일" } } });
  assert.equal(classifyGrantSourceChangeImpact({ previous, current }).classification, "evidence_refresh");
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
  assert.equal(parseGrantSourceChangeImpact({ ...first, schema: "grant-source-change-impact-v1" }), null,
    "과거 coverage 판정은 새 자동 재결속 근거로 승계하지 않는다");

  const unknownPrevious = projection({ source: "external", rawPayload: { body: "이전" } });
  const unknown = classifyGrantSourceChangeImpact({
    previous: unknownPrevious,
    current: projection({ source: "external", rawPayload: { body: "현재" } }),
  });
  assert.equal(unknown.classification, "unknown_review_required");
});
