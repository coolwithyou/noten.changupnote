/**
 * 그라운딩 순수 함수부 단위 테스트 (Apply Experience v2 · P3-3, node:assert, tsx 실행).
 *
 * 사용: pnpm test:chat-grounding
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §7.3 배치 규약 · ADR-2 전처리.
 * 커버:
 *   ① 가변 정보(lesson·프로필·fieldContext)가 system·documents(캐시 prefix)에 절대 미포함
 *   ② YAML frontmatter 절단(R2 URL 유출 방지)
 *   ③ 토큰 캡(앞에서부터 취함)
 *   ④ 본문성 소스 선택(양식만이면 bodySourceMissing)
 *   ⑤ cache_control 은 마지막 document 블록에만
 */
import assert from "node:assert/strict";
import {
  assembleGrounding,
  buildChatSystemPrompt,
  buildFieldContextBlock,
  capMarkdownByChars,
  charCapForTokens,
  pickGroundingSource,
  stripYamlFrontmatter,
  type GroundingArchiveCandidate,
} from "./grounding";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("그라운딩 순수 함수 단위 테스트\n");

function decodeDoc(dataBase64: string): string {
  return Buffer.from(dataBase64, "base64").toString("utf8");
}

const LESSON_SECRET = "레슨전용문구_ZZLESSON";
const PROFILE_SECRET = "프로필전용문구_ZZPROFILE";
const FIELD_SECRET = "필드전용문구_ZZFIELD";
const MARKDOWN_SECRET = "공고본문문구_ZZBODY";

// ① 가변 정보는 캐시 prefix(system·documents)에 절대 없고 dynamicContext/fieldContextBlock 에만.
check("① 가변 정보(lesson·프로필)는 system·documents 에 미포함, dynamicContext 에만", () => {
  const grounding = assembleGrounding({
    metaSummary: "[공고 기본 정보]\n제목: 테스트 공고",
    markdown: `# 공고문\n${MARKDOWN_SECRET}\n접수 마감: 2026-07-31`,
    markdownFilename: "공고문.txt",
    lessonBlock: `- [작성 지침/공식 문서] ${LESSON_SECRET}`,
    profileSummary: `[회사 확인 정보]\n- 소재지: ${PROFILE_SECRET}`,
    truncated: false,
    bodySourceMissing: false,
  });

  // system: 정적 규칙만 — lesson/profile 문구 없음.
  assert.ok(!grounding.system.includes(LESSON_SECRET), "system 에 lesson 유출");
  assert.ok(!grounding.system.includes(PROFILE_SECRET), "system 에 profile 유출");

  // documents(캐시 prefix): 메타 + markdown 만. lesson/profile 문구 없음.
  const docsText = grounding.documents.map((d) => decodeDoc(d.data)).join("\n");
  assert.ok(!docsText.includes(LESSON_SECRET), "documents 에 lesson 유출(캐시 prefix 오염)");
  assert.ok(!docsText.includes(PROFILE_SECRET), "documents 에 profile 유출(캐시 prefix 오염)");
  assert.ok(docsText.includes(MARKDOWN_SECRET), "documents 에 공고 본문 누락");

  // dynamicContext(캐시 이후): lesson·profile 포함.
  assert.ok(grounding.dynamicContext.includes(LESSON_SECRET), "dynamicContext 에 lesson 누락");
  assert.ok(grounding.dynamicContext.includes(PROFILE_SECRET), "dynamicContext 에 profile 누락");
});

// ①-b fieldContext(외부 유래)도 캐시 prefix·dynamicContext(세션 안정)에 없고 fieldContextBlock 에만.
check("①-b fieldContext 는 documents·dynamicContext 에 미포함, fieldContextBlock 에만", () => {
  const grounding = assembleGrounding({
    metaSummary: "[공고 기본 정보]\n제목: 테스트 공고",
    markdown: "# 공고문\n본문",
    markdownFilename: "공고문.txt",
    lessonBlock: "",
    profileSummary: "",
    fieldContext: { label: "사업 개요", textEvidence: FIELD_SECRET },
    truncated: false,
    bodySourceMissing: false,
  });
  const docsText = grounding.documents.map((d) => decodeDoc(d.data)).join("\n");
  assert.ok(!docsText.includes(FIELD_SECRET), "documents 에 fieldContext 유출(캐시 prefix 오염)");
  assert.ok(!grounding.dynamicContext.includes(FIELD_SECRET), "세션 안정 dynamicContext 에 per-메시지 fieldContext 유입");
  assert.ok(grounding.fieldContextBlock?.includes(FIELD_SECRET), "fieldContextBlock 에 textEvidence 누락");
  // 데이터 경계 명시(원칙 P9).
  assert.ok(grounding.fieldContextBlock?.includes("데이터"), "fieldContextBlock 에 데이터 경계 명시 누락");
});

// ② frontmatter 절단(R2 URL 유출 방지).
check("② stripYamlFrontmatter: 선두 --- 블록 절단(R2 URL 포함)", () => {
  const md = [
    "---",
    "source_url: https://r2.example.com/secret-key.hwp",
    "title: 공고",
    "---",
    "# 실제 공고문 시작",
    "접수 마감: 2026-07-31",
  ].join("\n");
  const stripped = stripYamlFrontmatter(md);
  assert.ok(!stripped.includes("r2.example.com"), "frontmatter 의 R2 URL 미절단");
  assert.ok(stripped.startsWith("# 실제 공고문 시작"), "본문 시작 지점 어긋남");
  // frontmatter 없는 문서는 원문 그대로.
  const plain = "# 바로 본문\n내용";
  assert.equal(stripYamlFrontmatter(plain), plain);
});

// ③ 토큰 캡: 앞에서부터 취함.
check("③ capMarkdownByChars: 초과 시 앞에서부터 취하고 truncated=true", () => {
  const charCap = charCapForTokens(24_000);
  assert.equal(charCap, Math.floor(24_000 * 1.6));
  const long = "가".repeat(charCap + 5_000);
  const capped = capMarkdownByChars(long, charCap);
  assert.equal(capped.truncated, true);
  assert.equal(capped.text.length, charCap);
  assert.equal(capped.text, long.slice(0, charCap));
  // 캡 이하이면 절단 없음.
  const short = capMarkdownByChars("짧은 문서", charCap);
  assert.equal(short.truncated, false);
  assert.equal(short.text, "짧은 문서");
});

// ③-b 절단 사실은 dynamicContext(캐시 이후)에 명시 — 배치 규약 정합(system 오염 금지).
check("③-b 절단 고지는 dynamicContext 에, system 은 불변", () => {
  const truncated = assembleGrounding({
    metaSummary: "메타",
    markdown: "본문",
    markdownFilename: "공고문.txt",
    lessonBlock: "",
    profileSummary: "",
    truncated: true,
    bodySourceMissing: false,
  });
  const notTruncated = assembleGrounding({
    metaSummary: "메타",
    markdown: "본문",
    markdownFilename: "공고문.txt",
    lessonBlock: "",
    profileSummary: "",
    truncated: false,
    bodySourceMissing: false,
  });
  // system 은 절단 여부와 무관하게 동일(정적).
  assert.equal(truncated.system, notTruncated.system);
  assert.equal(truncated.system, buildChatSystemPrompt());
  // 절단 고지는 dynamicContext 에.
  assert.ok(truncated.dynamicContext.includes("앞부분만"), "절단 고지 누락");
  assert.ok(!notTruncated.dynamicContext.includes("앞부분만"), "미절단인데 고지 존재");
});

// ④ 본문성 소스 선택.
check("④ pickGroundingSource: 양식만이면 bodySourceMissing, 공고문 있으면 선택", () => {
  const formsOnly: GroundingArchiveCandidate[] = [
    { filename: "사업계획서_양식.hwp", markdownStorageKey: "k1", markdownBytes: 5000 },
    { filename: "참가신청서.hwp", markdownStorageKey: "k2", markdownBytes: 3000 },
  ];
  const r1 = pickGroundingSource(formsOnly);
  assert.ok(r1.chosen, "후보가 있는데 chosen 이 null");
  assert.equal(r1.bodySourceMissing, true, "양식만인데 bodySourceMissing 이 false");

  const withBody: GroundingArchiveCandidate[] = [
    { filename: "사업계획서_양식.hwp", markdownStorageKey: "k1", markdownBytes: 9000 },
    { filename: "예비창업패키지_모집공고.hwp", markdownStorageKey: "k2", markdownBytes: 4000 },
  ];
  const r2 = pickGroundingSource(withBody);
  assert.equal(r2.chosen?.filename, "예비창업패키지_모집공고.hwp", "공고문을 우선 선택하지 않음");
  assert.equal(r2.bodySourceMissing, false);

  const none = pickGroundingSource([]);
  assert.equal(none.chosen, null);
  assert.equal(none.bodySourceMissing, true);
});

// ⑤ cache_control 은 마지막 document 블록에만(캐시 prefix 종료 지점).
check("⑤ cache_control 은 마지막 document 블록에만", () => {
  const grounding = assembleGrounding({
    metaSummary: "메타",
    markdown: "본문",
    markdownFilename: "공고문.txt",
    lessonBlock: "",
    profileSummary: "",
    truncated: false,
    bodySourceMissing: false,
  });
  assert.equal(grounding.documents.length, 2);
  assert.equal(grounding.documents[0]!.providerOptions.anthropic.cacheControl, undefined, "메타 블록에 cache_control 존재");
  assert.deepEqual(grounding.documents[1]!.providerOptions.anthropic.cacheControl, { type: "ephemeral" });
  // 모든 블록 citations 활성.
  for (const doc of grounding.documents) {
    assert.deepEqual(doc.providerOptions.anthropic.citations, { enabled: true });
  }

  // markdown 이 없으면 메타 블록이 캐시 종료 지점.
  const metaOnly = assembleGrounding({
    metaSummary: "메타",
    markdown: null,
    markdownFilename: null,
    lessonBlock: "",
    profileSummary: "",
    truncated: false,
    bodySourceMissing: true,
  });
  assert.equal(metaOnly.documents.length, 1);
  assert.deepEqual(metaOnly.documents[0]!.providerOptions.anthropic.cacheControl, { type: "ephemeral" });
});

// buildFieldContextBlock 데이터 경계 명시(원칙 P9) 단독 확인.
check("buildFieldContextBlock: 데이터 경계 + 라벨/구획/근거", () => {
  const block = buildFieldContextBlock({ label: "매출액", section: "재무", textEvidence: "최근 3개년 매출" });
  assert.ok(block.includes("데이터"));
  assert.ok(block.includes("매출액"));
  assert.ok(block.includes("재무"));
  assert.ok(block.includes("최근 3개년 매출"));
});

console.log(`\n✅ 그라운딩 단위 테스트 통과: ${passed}건`);
