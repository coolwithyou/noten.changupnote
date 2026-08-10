// 신규 분석 대상 자동 선정 단위 테스트.
// 실 DB·Claude CLI·파일 쓰기 없이 후보 필터, LLM 출력 검증, 목록 추가 순서를 고정한다.
import assert from "node:assert/strict";
import type { CohortFileV2 } from "./cohort-file";
import {
  buildBalancedShortlist,
  selectAutomaticAnalysisTargets,
  validateAutomaticTargetSelection,
  type AutomaticTargetCandidate,
} from "./target-selection";

function candidate(
  grantId: string,
  source: "kstartup" | "bizinfo",
  tier: "thick" | "medium" | "thin",
): AutomaticTargetCandidate {
  return {
    grantId,
    source,
    title: `공고 ${grantId}`,
    agency: "테스트 기관",
    category: "사업화",
    applyEnd: "2026-08-30T00:00:00.000Z",
    updatedAt: `2026-08-${grantId.padStart(2, "0")}T00:00:00.000Z`,
    stratum: `${source}/${tier}`,
    maxMarkdownBytes: tier === "thick" ? 50_000 : tier === "medium" ? 5_000 : 1_000,
    hwpAttachmentCount: 2,
    likelyApplicationDocumentCount: 1,
    attachmentNames: ["공고문.hwp", "신청서.hwp"],
  };
}

// 균형 shortlist는 한 그룹을 모두 소비하기 전에 source×두께 그룹을 순환한다.
{
  const candidates = [
    candidate("01", "kstartup", "thick"),
    candidate("02", "kstartup", "thick"),
    candidate("03", "bizinfo", "thick"),
    candidate("04", "kstartup", "medium"),
    candidate("05", "bizinfo", "medium"),
  ];
  const shortlist = buildBalancedShortlist(candidates, 3);
  assert.deepEqual(shortlist.slice(0, 4).map((item) => item.grantId), ["02", "03", "04", "05"]);
  console.log("✅ 자동 선정 shortlist — source×본문 두께 그룹 균형");
}

// LLM 출력은 정확한 수·후보 내부 ID·중복 없음·근거를 모두 만족해야 한다.
{
  const candidates = [candidate("01", "kstartup", "thick"), candidate("02", "bizinfo", "medium")];
  assert.throws(
    () => validateAutomaticTargetSelection([{ grantId: "01", reason: "적합한 공고" }], candidates, 2),
    /정확히 2건/,
  );
  assert.throws(
    () => validateAutomaticTargetSelection([
      { grantId: "01", reason: "첫 번째 적합" },
      { grantId: "outside", reason: "후보 밖 공고" },
    ], candidates, 2),
    /후보 밖/,
  );
  assert.throws(
    () => validateAutomaticTargetSelection([
      { grantId: "01", reason: "첫 번째 적합" },
      { grantId: "01", reason: "중복 선택" },
    ], candidates, 2),
    /중복/,
  );
  console.log("✅ 자동 선정 LLM 출력 — 정확 수량·allowlist·중복 가드");
}

// 기존 목록과 과거 런을 제외한 신규 공고만 LLM에 전달하고, 검증 뒤 목록과 근거를 쓴다.
{
  const existing: CohortFileV2 = {
    version: 2,
    selectedAt: "2026-08-01T00:00:00.000Z",
    seed: 1,
    experimentLabel: "old",
    entries: [{ grantId: "01", stratum: "kstartup/thick" }],
  };
  const allCandidates = [
    candidate("01", "kstartup", "thick"),
    candidate("02", "bizinfo", "thick"),
    candidate("03", "kstartup", "medium"),
    candidate("04", "bizinfo", "medium"),
  ];
  let writtenTargetIds: string[] = [];
  let evidenceWritten = false;
  const result = await selectAutomaticAnalysisTargets(
    {
      count: 2,
      transport: "claude-cli",
      apiKey: "subscription",
      fetchImpl: fetch,
      model: "claude-test",
    },
    {
      now: () => new Date("2026-08-06T01:00:00.000Z"),
      readTargets: async () => existing,
      scanAnalyzedGrantIds: async () => new Set(["01", "02"]),
      loadCandidates: async () => allCandidates,
      callModel: async ({ candidates }) => {
        assert.deepEqual(candidates.map((item) => item.grantId).sort(), ["03", "04"]);
        return {
          selected: candidates.map((item) => ({ grantId: item.grantId, reason: "전체 사이클 검증에 적합" })),
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 },
        };
      },
      writeTargets: async (file) => {
        writtenTargetIds = file.entries.map((entry) => entry.grantId);
      },
      writeEvidence: async (selection) => {
        assert.equal(writtenTargetIds.length, 3, "목록을 먼저 원자 교체한 뒤 근거를 저장한다");
        assert.equal(selection.previousTargetCount, 1);
        evidenceWritten = true;
      },
    },
  );
  assert.deepEqual(writtenTargetIds, ["01", "03", "04"]);
  assert.equal(result.targetCount, 3);
  assert.equal(result.selected.length, 2);
  assert.equal(evidenceWritten, true);
  console.log("✅ 자동 선정 적용 — 기존 대상·과거 런 제외, 신규 대상 append, 근거 저장");
}

// 기존 목록에 미분석 대기가 있으면 추가 선정을 차단해 파일럿 범위가 조용히 늘지 않는다.
{
  let modelCalls = 0;
  await assert.rejects(
    selectAutomaticAnalysisTargets(
      {
        count: 1,
        transport: "claude-cli",
        apiKey: "subscription",
        fetchImpl: fetch,
        model: "claude-test",
      },
      {
        now: () => new Date("2026-08-06T01:00:00.000Z"),
        readTargets: async () => ({
          version: 2,
          selectedAt: "2026-08-06T00:00:00.000Z",
          seed: null,
          experimentLabel: "pilot",
          entries: [{ grantId: "pending", stratum: "bizinfo/medium" }],
        }),
        scanAnalyzedGrantIds: async () => new Set(),
        loadCandidates: async () => [
          candidate("pending", "bizinfo", "medium"),
          candidate("01", "kstartup", "thick"),
        ],
        callModel: async () => {
          modelCalls += 1;
          return { selected: [], usage: null };
        },
      },
    ),
    /현재 분석 대기 1건/,
  );
  assert.equal(modelCalls, 0);
  console.log("✅ 자동 선정 범위 가드 — 기존 대기 처리 전 추가 선정·모델 호출 차단");
}

// 마감·비노출 등으로 안전 후보에서 빠진 과거 대기는 새 모집 공고 선정을 영구 차단하지 않는다.
{
  let writtenTargetIds: string[] = [];
  const result = await selectAutomaticAnalysisTargets(
    {
      count: 1,
      transport: "claude-cli",
      apiKey: "subscription",
      fetchImpl: fetch,
      model: "claude-test",
    },
    {
      now: () => new Date("2026-08-06T01:00:00.000Z"),
      readTargets: async () => ({
        version: 2,
        selectedAt: "2026-08-01T00:00:00.000Z",
        seed: null,
        experimentLabel: "old",
        entries: [{ grantId: "expired", stratum: "bizinfo/medium" }],
      }),
      scanAnalyzedGrantIds: async () => new Set(),
      loadCandidates: async () => [candidate("new", "kstartup", "thick")],
      callModel: async ({ candidates }) => ({
        selected: [{ grantId: candidates[0]!.grantId, reason: "현재 모집 중인 새 분석 대상" }],
        usage: null,
      }),
      writeTargets: async (file) => {
        writtenTargetIds = file.entries.map((entry) => entry.grantId);
      },
      writeEvidence: async () => undefined,
    },
  );
  assert.deepEqual(writtenTargetIds, ["expired", "new"]);
  assert.equal(result.selected[0]?.grantId, "new");
  console.log("✅ 자동 선정 반복성 — 비활성 과거 대기는 새 모집 공고 선정을 차단하지 않음");
}

// 잘못된 모델 응답은 canonical 목록에 어떤 쓰기도 만들지 않는다.
{
  let writes = 0;
  await assert.rejects(
    selectAutomaticAnalysisTargets(
      {
        count: 1,
        transport: "claude-cli",
        apiKey: "subscription",
        fetchImpl: fetch,
        model: "claude-test",
      },
      {
        now: () => new Date("2026-08-06T01:00:00.000Z"),
        readTargets: async () => null,
        scanAnalyzedGrantIds: async () => new Set(),
        loadCandidates: async () => [candidate("01", "kstartup", "thick")],
        callModel: async () => ({
          selected: [{ grantId: "outside", reason: "후보 밖 공고" }],
          usage: null,
        }),
        writeTargets: async () => {
          writes += 1;
        },
        writeEvidence: async () => {
          writes += 1;
        },
      },
    ),
    /후보 밖/,
  );
  assert.equal(writes, 0);
  console.log("✅ 자동 선정 실패 원자성 — 검증 실패 시 목록·근거 무수정");
}

// 반복형 에이전트는 신규 안전 후보가 요청 상한보다 적으면 남은 후보만 정확히 선정한다.
{
  const result = await selectAutomaticAnalysisTargets(
    {
      count: 3,
      transport: "claude-cli",
      apiKey: "subscription",
      fetchImpl: fetch,
      model: "claude-test",
      allowFewer: true,
    },
    {
      now: () => new Date("2026-08-06T01:00:00.000Z"),
      readTargets: async () => null,
      scanAnalyzedGrantIds: async () => new Set(),
      loadCandidates: async () => [
        candidate("01", "kstartup", "thick"),
        candidate("02", "bizinfo", "medium"),
      ],
      callModel: async ({ count, candidates }) => ({
        selected: candidates.slice(0, count).map((item) => ({
          grantId: item.grantId,
          reason: "남아 있는 안전한 신규 분석 대상",
        })),
        usage: null,
      }),
      writeTargets: async () => undefined,
      writeEvidence: async () => undefined,
    },
  );
  assert.equal(result.requestedCount, 3);
  assert.equal(result.selected.length, 2);
  console.log("✅ 자동 선정 소량 유입 — 요청 상한보다 적은 신규 공고도 반복 처리");
}
