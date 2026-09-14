// 2단 effort 배선 검증(2026-08-11 계획 §2-3-3, §3-T1):
// ① effort env/옵션 해석(미설정→null, 무효값 fail-fast)
// ② round 0에만 output_config.effort를 싣고 재판정 라운드는 기본 effort
// ③ round 0 저효율의 거절 수락 임계 0.85(경계 구간은 uncertain → 재판정에서 회복)
// ④ effort 미설정이면 현행과 100% 동일 동작
import assert from "node:assert/strict";
import type { IRBlock } from "kordoc";
import type { RoundtripFieldCandidate } from "@/lib/server/analysis-lab/application-roundtrip/contract";
import {
  buildRoundtripFieldSourceContexts,
  findSurroundingText,
  planRoundtripFields,
  resolveRoundtripEffort,
  resolveRoundtripFieldPlannerRuntimeConfig,
} from "./field-planner";
import { finalizeRoundtripFieldCoverage } from "./field-coverage";

const originalEffortEnv = process.env.APPLICATION_ROUNDTRIP_EFFORT;

try {
  // PBLN_000000000126414 / e5db1e8c842fd75996e7.parsed.md의 label/Markdown 공백 차이.
  // 응답 판정은 합성이며 요청 원문만 검증한다.
  {
    const field = { ...candidate("spaced-label"), label: "신 청 내 역" };
    const section = '<tr><td colspan="6">신청내역</td></tr>\n'
      + '<tr><td colspan="2">구분</td><td colspan="4">발송비용 (총액만 기재, 상세 내역은 추가 서식 제출)</td></tr>\n'
      + '<tr><td colspan="2">국내운송비</td><td colspan="4">원(VAT제외)</td></tr>';
    const markdown = "앞".repeat(300) + section + "뒤".repeat(400);
    const context = findSurroundingText(markdown, field);
    assert.ok(context.includes(section), "원래 colspan과 인접 금액 행을 함께 전달");
    assert.ok(markdown.includes(context), "정규화한 텍스트가 아닌 정확한 원문 slice");
    const bodies: Array<Record<string, unknown>> = [];
    await planRoundtripFields({ fields: [field], markdown, apiKey: "subscription",
      transport: "claude-cli", fetchImpl: buildFetch(bodies, [[decision("spaced-label", false, 0.9, "신청내역")]]) });
    const payload = (bodies[0]?.messages as Array<{ content: string }>)[0]!.content;
    const candidates = JSON.parse(payload.slice(payload.indexOf("\n") + 1));
    assert.equal(candidates[0].surrounding_text, context);
    assert.equal(bodies.length, 1);

    assert.equal(findSurroundingText("앞 회사명 뒤", { ...field, label: "회사명" }), "앞 회사명 뒤");
    assert.equal(findSurroundingText("신청내역 / 신청 내역", field), "", "정규화 충돌은 임의 선택하지 않음");
    assert.equal(findSurroundingText("회사명 / 회사명", { ...field, label: "회사명" }), "",
      "구조 위치가 없는 fallback은 반복된 exact 라벨도 임의 선택하지 않음");
    for (const boundary of ["\n", "\r", "\f", "\v", "\u2028", "\u2029"]) {
      assert.equal(findSurroundingText(`신청${boundary}내역`, field), "", "행·페이지 경계를 공백으로 합치지 않음");
    }
    for (const label of ["신청A B", "신청1 2", "신청-내역"]) {
      assert.equal(findSurroundingText("신청AB 신청12 신청내역", { ...field, label }), "");
    }
    const nested = `<table><tr><td><table>${section}</table></td></tr></table>`;
    assert.ok(findSurroundingText(nested, field).includes(section), "중첩 표의 위치를 행 번호로 추정하지 않음");
    assert.equal(findSurroundingText("🚀 신 청 내 역 💡", { ...field, label: "신청내역" }), "🚀 신 청 내 역 💡");
  }
  // ---- 구조 위치 문맥 및 negative evidence 결속 ------------------------------------
  {
    const field = {
      ...candidate("techfest-joint-representative"),
      label: "공동대표",
      displayLabel: "공동대표",
      normalizedLabel: "공동대표",
      helperText: "원래 구조 후보 설명",
      location: { blockIndex: 106, row: 17, col: 1, occurrence: 0, pageNumber: 1 },
    };
    const blocks: IRBlock[] = Array.from({ length: 107 }, () => ({ type: "paragraph", text: "" }));
    const rows = Array.from({ length: 20 }, () => [
      { text: "", colSpan: 1, rowSpan: 1 },
      { text: "", colSpan: 1, rowSpan: 1 },
      { text: "", colSpan: 1, rowSpan: 1 },
    ]);
    rows[14] = [{ text: "기업 구성 현황", colSpan: 3, rowSpan: 1 }];
    rows[16] = [
      { text: "성명", colSpan: 1, rowSpan: 1 },
      { text: "직위", colSpan: 1, rowSpan: 1 },
      { text: "담당업무", colSpan: 1, rowSpan: 1 },
    ];
    rows[17] = [
      { text: "", colSpan: 1, rowSpan: 1 },
      { text: "공동대표/대리", colSpan: 1, rowSpan: 1 },
      { text: "", colSpan: 1, rowSpan: 1 },
    ];
    blocks[106] = { type: "table", table: { rows: 20, cols: 3, hasHeader: true, cells: rows } };
    const fieldSourceContexts = buildRoundtripFieldSourceContexts(blocks, [field]);
    const structuralContext = fieldSourceContexts.get(field.fieldInstanceId);
    assert.equal(structuralContext?.binding, "block_row_col");
    assert.equal(structuralContext?.blockIndex, 106);
    assert.equal(structuralContext?.row, 17);
    assert.equal(structuralContext?.col, 1);
    assert.match(structuralContext?.text ?? "", /기업 구성 현황/);
    assert.match(structuralContext?.text ?? "", /col1 TARGET.*공동대표\/대리/);

    const bodies: Array<Record<string, unknown>> = [];
    const foreignEvidence = "공동대표 또는 각자대표로 구성된 기업의 경우 대표자 전원이 신청자격에 해당";
    const { fields, summary } = await planRoundtripFields({
      fields: [field],
      markdown: `${foreignEvidence}\n${"다른 내용".repeat(200)}`,
      fieldSourceContexts,
      apiKey: "subscription",
      transport: "claude-cli",
      fetchImpl: buildFetch(bodies, [
        [decision(field.fieldInstanceId, false, 0.9, foreignEvidence, "잘못된 신청자격 설명")],
        [decision(field.fieldInstanceId, false, 0.9, foreignEvidence, "잘못된 신청자격 설명")],
        [decision(field.fieldInstanceId, false, 0.9, foreignEvidence, "잘못된 신청자격 설명")],
      ]),
    });
    const payload = JSON.parse(
      String(((bodies[0]?.messages as Array<{ content: string }>)[0]?.content ?? "")).split("\n").slice(1).join("\n"),
    );
    assert.deepEqual(payload[0].source_context, {
      binding: "block_row_col",
      block_index: 106,
      row: 17,
      col: 1,
    }, "요청은 후보의 exact block/row/col 결속을 전달");
    assert.equal(payload[0].surrounding_text, structuralContext?.text, "원문 문맥은 중복 없이 한 번만 전달");
    assert.equal(bodies.length, 2, "같은 짧은 인용 실패를 두 번 받은 후보는 세 번째 동일 재판정을 생략");
    const retryPayload = parseCandidatePayload(bodies[1]!);
    assert.deepEqual(retryPayload[0]?.previous_evidence_rejections, [{
      round: 0,
      reason: "not_contiguous",
      evidence: foreignEvidence,
    }], "다음 재판정에 후보별 bounded 인용 실패와 원인을 전달");
    assert.match(String(bodies[1]?.system ?? ""), /의미 판정의 정답으로 간주하지 말고/,
      "이전 인용 실패가 재판정 의미를 고정하지 않음");
    assert.match(JSON.stringify(bodies[0]?.tools), /단일 연속 문자열/,
      "도구 schema에도 단일 연속 인용 계약을 명시");
    assert.equal(fields[0]?.llmDecision, "uncertain", "다른 위치 근거로 고신뢰 비입력을 확정하지 않음");
    assert.equal(fields[0]?.helperText, "원래 구조 후보 설명", "불일치 판정 설명으로 후보 의미를 덮지 않음");
    assert.equal(fields[0]?.displayLabel, "공동대표", "불일치 판정 표시명으로 후보 의미를 덮지 않음");
    assert.equal(summary.adjudicationStatus, "partial");
    assert.match(fields[0]?.inputSignals.join(" ") ?? "", /근거 위치 불일치/);

    const titleField = {
      ...candidate("section-title"),
      label: "기업 구성 현황",
      displayLabel: "기업 구성 현황",
      normalizedLabel: "기업구성현황",
      location: { blockIndex: 106, row: 14, col: 0, occurrence: 0, pageNumber: 1 },
    };
    const titleContexts = buildRoundtripFieldSourceContexts(blocks, [titleField]);
    const local = await planRoundtripFields({
      fields: [titleField],
      markdown: "",
      fieldSourceContexts: titleContexts,
      apiKey: "subscription",
      transport: "claude-cli",
      fetchImpl: buildFetch([], [[decision(titleField.fieldInstanceId, false, 0.9, "기업 구성 현황")]]),
    });
    assert.equal(local.fields[0]?.llmDecision, "not_input", "해당 위치의 실제 구획 제목 negative는 확정 가능");
    assert.match(local.fields[0]?.inputSignals.join(" ") ?? "", /구조 위치 결속 확인/);
    console.log("✅ RHWP 후보 문맥 — block/row/col 결속 및 다른 위치 negative 차단");
  }
  // ---- TECHFEST 원문 위치 3건: 실패 진단 전달 후 구조 결속 negative 회복 ------------
  {
    // source SHA256 5d9ad6200091e341c945f1c746b1512ded6f2d85f0aa21bd6f0eac5b566fe22c
    // 에서 판정 대상 행과 bounded 인접 행만 옮긴 회귀 fixture다. 과거 raw rejected evidence는
    // 저장되지 않았으므로 최초 응답은 관측 사실을 가장하지 않는 합성 비연속 인용이다.
    const blocks: IRBlock[] = Array.from({ length: 112 }, () => ({ type: "paragraph", text: "" }));
    blocks[61] = tableBlock([
      tableRow("①모집 및 접수", "![image](image_003.bmp)", "②서류평가", "![image](image_003.bmp)", "③발표평가", "![image](image_003.bmp)", "④최종 선정"),
      tableRow("K-STARTUP\n온라인 접수", "", "사업계획서 및\n제출자료 검토", "", "영어 발표평가", "", "최종 요건검토 및\n선정결과 발표"),
      tableRow("9.10.(목) ~ 9.17.(목)", "", "~9.22.(화)", "", "9.29.(화) 예정", "", "~ 10.6.(화)"),
      tableRow("", "", "", "", "", "", ""),
    ]);
    const companyRows = Array.from({ length: 19 }, () => tableRow(...Array.from({ length: 11 }, () => "")));
    companyRows[13] = tableRow("", "", "", "", "", "", "", "", "신청일 현재", "00백만원", "");
    companyRows[14] = tableRow("신청기업 홈페이지", "", "", "", "[www.k-startup.go.kr](http://www.k-startup.go.kr)", "", "", "", "", "", "");
    companyRows[15] = tableRow("기업 구성 현황 (대표자 본인 제외 공동·각자대표 포함)", "", "", "", "", "", "", "", "", "", "");
    companyRows[16] = tableRow("연번", "직위", "", "담당 업무", "", "", "보유역량(경력 및 학력 등)", "", "", "", "구성 상태");
    companyRows[17] = tableRow("1", "공동대표", "", "S/W 개발 총괄", "", "", "OO학 박사, OO학과 교수 재직(00년)", "", "", "", "완료");
    companyRows[18] = tableRow("2", "대리", "", "해외 영업", "", "", "OO학 학사, OO 관련 경력(00년 이상)", "", "", "", "예정(’00.0)");
    blocks[106] = tableBlock(companyRows);
    blocks[111] = tableBlock([tableRow("참 고", "", "2026년 베트남 테크페스트(TECHFEST) 개요")]);

    const targetSpecs = [
      { id: "8a1be818ff580276f82f31c6", label: "영어 발표평가", blockIndex: 61, row: 1, col: 4,
        rejected: "영어 발표평가 최종 요건검토" },
      { id: "2353259a4fa428a79d532953", label: "담당 업무", blockIndex: 106, row: 16, col: 3,
        rejected: "담당 업무 보유역량" },
      { id: "b498ee03ca75c2693f8266d2", label: "참 고", blockIndex: 111, row: 0, col: 0,
        rejected: "참 고 TECHFEST 개요" },
    ];
    const candidates = targetSpecs.map((spec) => ({
      ...candidate(spec.id),
      label: spec.label,
      displayLabel: spec.label,
      normalizedLabel: spec.label.replace(/\s/gu, ""),
      source: "rhwp-structural" as const,
      writeOperation: "rhwp_field" as const,
      location: { blockIndex: spec.blockIndex, row: spec.row, col: spec.col, occurrence: 0, pageNumber: 1 },
    }));
    const contexts = buildRoundtripFieldSourceContexts(blocks, candidates);
    const bodies: Array<Record<string, unknown>> = [];
    const result = await planRoundtripFields({
      fields: candidates,
      markdown: "",
      fieldSourceContexts: contexts,
      apiKey: "subscription",
      transport: "claude-cli",
      fetchImpl: buildFetch(bodies, [
        targetSpecs.map((spec) => decision(spec.id, false, 0.92, spec.rejected)),
        targetSpecs.map((spec) => decision(spec.id, false, 0.92, spec.label)),
      ]),
    });
    assert.equal(bodies.length, 2, "세 후보 모두 1회 교정 재판정에서 회복");
    const retryPayload = parseCandidatePayload(bodies[1]!);
    assert.deepEqual(
      retryPayload.map((item) => item.previous_evidence_rejections?.[0]?.reason),
      ["not_contiguous", "not_contiguous", "not_contiguous"],
      "세 후보의 최초 비연속 인용 실패를 각 후보 payload에 보존",
    );
    assert.equal(result.summary.adjudicationStatus, "resolved");
    for (const field of result.fields) {
      assert.equal(field.llmDecision, "not_input");
      assert.equal(field.llmDecisionRound, 1);
      assert.equal(field.llmRejectedEvidenceAttempts?.length, 1);
      assert.match(field.inputSignals.join(" "), /근거 위치 불일치.*구조 위치 결속 확인/s);
    }
    assert.equal(
      finalizeRoundtripFieldCoverage(result.fields).status,
      "complete",
      "최종 구조 결속 not_input은 과거 mismatch 진단 때문에 계속 hold되지 않음",
    );
    console.log("✅ TECHFEST 원문 3건 — 인용 실패 전달 후 1회 교정 및 coverage 회복");
  }
  // ---- 동일 missing 실패는 한 번만 교정하고 unresolved로 보존 -----------------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const result = await planRoundtripFields({
      fields: [candidate("missing-evidence")],
      markdown: "회사명: ____",
      apiKey: "subscription",
      transport: "claude-cli",
      fetchImpl: buildFetch(bodies, [
        [decision("missing-evidence", false, 0.95, "")],
        [decision("missing-evidence", false, 0.95, "")],
        [decision("missing-evidence", false, 0.95, "회사명")],
      ]),
    });
    assert.equal(bodies.length, 2, "동일 missing 실패의 불필요한 두 번째 교정 호출을 생략");
    assert.equal(result.summary.adjudicationRounds, 1);
    assert.equal(result.summary.adjudicationStatus, "partial");
    assert.equal(result.fields[0]?.llmDecision, "uncertain");
    assert.deepEqual(result.fields[0]?.llmRejectedEvidenceAttempts, [
      { round: 0, reason: "missing", evidence: "" },
      { round: 1, reason: "missing", evidence: "" },
    ]);
    assert.deepEqual(parseCandidatePayload(bodies[1]!)[0]?.previous_evidence_rejections, [
      { round: 0, reason: "missing", evidence: "" },
    ]);
    console.log("✅ 동일 missing 실패 — 1회 교정 뒤 fail-closed");
  }
  // ---- 300자 경계에서 같은 prefix로 잘린 서로 다른 응답은 동일 실패로 단정하지 않음 ----
  {
    const bodies: Array<Record<string, unknown>> = [];
    const prefix = "가".repeat(300);
    const result = await planRoundtripFields({
      fields: [candidate("truncated-evidence")],
      markdown: "회사명: ____",
      apiKey: "subscription",
      transport: "claude-cli",
      fetchImpl: buildFetch(bodies, [
        [decision("truncated-evidence", false, 0.95, `${prefix}첫째`)],
        [decision("truncated-evidence", false, 0.95, `${prefix}둘째`)],
        [decision("truncated-evidence", false, 0.95, "회사명")],
      ]),
    });
    assert.equal(bodies.length, 3, "서로 다른 긴 응답의 잘린 prefix만으로 두 번째 교정을 생략하지 않음");
    assert.equal(result.fields[0]?.llmDecision, "not_input");
    assert.equal(result.fields[0]?.llmDecisionRound, 2);
    assert.deepEqual(
      result.fields[0]?.llmRejectedEvidenceAttempts?.map((attempt) => attempt.evidence.length),
      [300, 300],
      "보존 evidence는 라운드별 300자로 제한",
    );
    console.log("✅ rejected evidence 300자 경계 — 잘린 prefix 충돌 시 재판정 보존");
  }
  // ---- ① effort 해석 -------------------------------------------------------------
  delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
  assert.equal(resolveRoundtripEffort(), null, "env 미설정 → null(현행 = effort 미지정)");
  process.env.APPLICATION_ROUNDTRIP_EFFORT = "  ";
  assert.equal(resolveRoundtripEffort(), null, "공백/빈 문자열 → null");
  process.env.APPLICATION_ROUNDTRIP_EFFORT = "medium";
  assert.equal(resolveRoundtripEffort(), "medium");
  assert.equal(resolveRoundtripEffort("low"), "low", "명시 옵션이 env보다 우선");
  assert.equal(resolveRoundtripEffort("high"), "high");
  assert.equal(resolveRoundtripEffort(null), null, "명시 null은 env를 무시하고 미지정");
  assert.equal(
    resolveRoundtripFieldPlannerRuntimeConfig({ transport: "claude-cli" }).effort,
    "medium",
    "runtime config가 env를 해석",
  );
  process.env.APPLICATION_ROUNDTRIP_EFFORT = "meduim";
  assert.throws(() => resolveRoundtripEffort(), /APPLICATION_ROUNDTRIP_EFFORT/, "env 오타 fail-fast");
  assert.throws(() => resolveRoundtripEffort("max"), /APPLICATION_ROUNDTRIP_EFFORT/, "명시 옵션 오타도 fail-fast");
  delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
  assert.equal(
    resolveRoundtripFieldPlannerRuntimeConfig({ transport: "claude-cli" }).effort,
    null,
    "env 미설정 기본값은 현행과 동일(미지정)",
  );
  console.log("✅ resolveRoundtripEffort — 미설정/빈값/low/medium/high/오타 fail-fast");

  // ---- ② round 0에만 output_config.effort ----------------------------------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = buildFetch(bodies, [
      // round 0: cand-a 확정, cand-b는 저신뢰 입력 → uncertain으로 남아 재판정 유발
      [decision("cand-a", true, 0.9), decision("cand-b", true, 0.5)],
      // round 1: cand-b 확정
      [decision("cand-b", true, 0.9)],
    ]);
    const { summary } = await planRoundtripFields({
      fields: [candidate("cand-a"), candidate("cand-b")],
      markdown: "회사명: ____",
      apiKey: "test-key",
      fetchImpl,
      transport: "claude-cli",
      effort: "medium",
    });
    assert.equal(bodies.length, 2, "최초 판정 1회 + 재판정 1회");
    assert.deepEqual(bodies[0]?.output_config, { effort: "medium" }, "round 0 요청에는 effort를 싣는다");
    assert.equal("output_config" in (bodies[1] ?? {}), false, "재판정 라운드는 effort 미지정(기본)");
    assert.equal(summary.effort, "medium", "summary에 effort provenance 기록");
    assert.equal(summary.adjudicationStatus, "resolved");
    console.log("✅ 2단 effort — round 0에만 output_config.effort, 재판정은 기본 effort");
  }

  // ---- ③ round 0 저효율 거절 임계 0.85 --------------------------------------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = buildFetch(bodies, [
      // round 0(저효율): 0.8 거절은 0.85 게이트에 걸려 uncertain, 0.9 거절은 즉시 수락
      [decision("cand-a", false, 0.8), decision("cand-b", false, 0.9)],
      // round 1(기본 effort): 같은 0.8 거절이 현행 임계 0.75로 확정
      [decision("cand-a", false, 0.8)],
    ]);
    const { fields, summary } = await planRoundtripFields({
      fields: [candidate("cand-a"), candidate("cand-b")],
      markdown: "회사명: ____",
      apiKey: "test-key",
      fetchImpl,
      transport: "claude-cli",
      effort: "medium",
    });
    const candA = fields.find((field) => field.fieldInstanceId === "cand-a");
    const candB = fields.find((field) => field.fieldInstanceId === "cand-b");
    assert.equal(candB?.llmDecision, "not_input", "conf 0.9 거절은 저효율에서도 즉시 수락");
    assert.equal(candB?.llmDecisionRound, 0);
    assert.equal(candA?.llmDecision, "not_input");
    assert.equal(
      candA?.llmDecisionRound,
      1,
      "conf 0.8 거절은 round 0(저효율)에서 uncertain으로 남아 재판정에서 확정",
    );
    assert.equal(summary.adjudicationRounds, 1);
    console.log("✅ 저효율 거절 임계 — [0.75,0.85) 경계 구간을 재판정으로 회복");
  }

  // ---- ④ effort 미설정 = 현행 동일 -------------------------------------------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = buildFetch(bodies, [[decision("cand-a", false, 0.8)]]);
    const { fields, summary } = await planRoundtripFields({
      fields: [candidate("cand-a")],
      markdown: "회사명: ____",
      apiKey: "test-key",
      fetchImpl,
      transport: "claude-cli",
    });
    assert.equal(bodies.length, 1, "재판정 라운드 없음");
    assert.equal("output_config" in (bodies[0] ?? {}), false, "effort 미지정이면 요청 본문 현행 동일");
    assert.equal(fields[0]?.llmDecision, "not_input", "conf 0.8 거절은 현행 임계 0.75로 즉시 수락");
    assert.equal(fields[0]?.llmDecisionRound, 0);
    assert.equal(summary.effort, null);
    console.log("✅ effort 미설정 — 요청 본문·거절 임계 모두 현행 그대로");
  }

  // ---- ⑤ 확정 후보는 결정 규칙으로 끝내고 경계 후보만 LLM 판정 ----------------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = buildFetch(bodies, [[decision("ambiguous", true, 0.9)]]);
    const { fields, summary } = await planRoundtripFields({
      fields: [
        candidate("certain-input", { inputLikelihood: 0.86, recommendedInput: true }),
        candidate("ambiguous", { inputLikelihood: 0.59, recommendedInput: false }),
        candidate("certain-non-input", { inputLikelihood: 0.14, recommendedInput: false }),
      ],
      markdown: "회사명: ____",
      apiKey: "test-key",
      fetchImpl,
      transport: "claude-cli",
    });
    const payload = ((bodies[0]?.messages as Array<{ content: string }>)[0]?.content ?? "");
    assert.match(payload, /ambiguous/);
    assert.doesNotMatch(payload, /certain-input|certain-non-input/);
    assert.equal(fields.find((field) => field.fieldInstanceId === "certain-input")?.recommendedInput, true);
    assert.equal(fields.find((field) => field.fieldInstanceId === "certain-non-input")?.recommendedInput, false);
    assert.equal(summary.candidateCount, 3, "구조 후보 총수는 보존");
    assert.equal(summary.llmCandidateCount, 1, "LLM 요청 대상은 경계 후보만 기록");
    assert.equal(summary.deterministicDecisionCount, 2, "결정 규칙으로 종결한 후보 수 기록");
    console.log("✅ Kordoc triage — 경계 후보만 LLM 판정");
  }

  // ---- ⑥ 반복되는 양의 저신뢰 판정은 optional 사용자 확인 입력으로 보존 --------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = buildFetch(bodies, [
      [decision("conditional-input", true, 0.7)],
      [decision("conditional-input", true, 0.72)],
    ]);
    const { fields, summary } = await planRoundtripFields({
      fields: [candidate("conditional-input")],
      markdown: "해당 란은 신청자가 확인하여 입력",
      apiKey: "subscription",
      fetchImpl,
      transport: "claude-cli",
    });
    assert.equal(bodies.length, 2, "같은 양의 보류를 세 번째로 반복하지 않음");
    assert.equal(summary.adjudicationStatus, "resolved");
    assert.equal(summary.remainingUnresolvedCandidateCount, 0);
    assert.equal(fields[0]?.llmDecision, "input");
    assert.equal(fields[0]?.recommendedInput, true);
    assert.equal(fields[0]?.required, false, "확정값이 아니라 optional 사용자 확인 입력");
    assert.match(fields[0]?.inputSignals.join(" ") ?? "", /사용자 확인 입력으로 보존/);
    console.log("✅ 반복 양의 보류 — optional 사용자 확인 입력으로 수렴");
  }
} finally {
  if (originalEffortEnv === undefined) delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
  else process.env.APPLICATION_ROUNDTRIP_EFFORT = originalEffortEnv;
}

console.log("application roundtrip field-planner effort tests: ok");

function candidate(
  id: string,
  overrides: Partial<Pick<RoundtripFieldCandidate, "inputLikelihood" | "recommendedInput">> = {},
): RoundtripFieldCandidate {
  return {
    fieldInstanceId: id,
    label: "회사명",
    displayLabel: "회사명",
    normalizedLabel: "회사명",
    originalValue: "",
    type: "text",
    required: false,
    empty: true,
    recommendedInput: overrides.recommendedInput ?? false,
    inputLikelihood: overrides.inputLikelihood ?? 0.5,
    inputSignals: [],
    sampleValue: "",
    sampleReason: "",
    source: "kordoc-form",
    inputKind: "text",
    writeOperation: "kordoc_field",
    helperText: null,
    unit: null,
    options: [],
    analysisSource: "heuristic",
    llmConfidence: null,
    location: { blockIndex: 0, row: 0, col: 0, occurrence: 0, pageNumber: null },
  };
}

function decision(
  candidateId: string,
  isUserInput: boolean,
  confidence: number,
  evidence = "회사명",
  helpText = "",
): Record<string, unknown> {
  return {
    candidate_id: candidateId,
    is_user_input: isUserInput,
    suggested_label: "",
    input_kind: isUserInput ? "text" : "none",
    confidence,
    help_text: helpText,
    evidence,
  };
}

/** 요청 body를 캡처하고 라운드(호출 순서)별 준비된 판정을 돌려주는 주입용 fetch. */
function buildFetch(
  capturedBodies: Array<Record<string, unknown>>,
  decisionsByCall: Array<Array<Record<string, unknown>>>,
): typeof fetch {
  let call = 0;
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    capturedBodies.push(body);
    const decisions = decisionsByCall[Math.min(call, decisionsByCall.length - 1)] ?? [];
    call += 1;
    return new Response(
      JSON.stringify({
        content: [{ type: "tool_use", name: "emit_application_field_plan", input: { decisions } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

function parseCandidatePayload(body: Record<string, unknown>): Array<{
  previous_evidence_rejections?: Array<{ round: number; reason: string; evidence: string }>;
}> {
  const content = (body.messages as Array<{ content: string }>)[0]?.content ?? "";
  return JSON.parse(content.slice(content.indexOf("\n") + 1));
}

function tableRow(...values: string[]) {
  return values.map((text) => ({ text, colSpan: 1, rowSpan: 1 }));
}

function tableBlock(cells: ReturnType<typeof tableRow>[]): IRBlock {
  return {
    type: "table",
    table: {
      rows: cells.length,
      cols: Math.max(0, ...cells.map((row) => row.length)),
      hasHeader: true,
      cells,
    },
  };
}
