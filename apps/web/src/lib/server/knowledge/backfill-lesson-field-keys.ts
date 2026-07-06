/**
 * 기존 lesson 백필: scope.fieldPattern 은 있으나 scope.fieldKey 가 없는 lesson 에
 * Gate 1 표준 key(fieldKeyDictionary) 를 결정적(규칙 기반) 으로 제안한다.
 *
 * 사용:
 *   dry-run(기본): npx tsx --env-file=.env --env-file=.env.local --tsconfig apps/web/tsconfig.json \
 *     apps/web/src/lib/server/knowledge/backfill-lesson-field-keys.ts
 *   실제 반영:      ...(위 명령) -- --write
 *   (package.json: pnpm backfill:lesson-field-keys  /  pnpm backfill:lesson-field-keys -- --write)
 *
 * 원칙:
 *   - LLM 호출 금지. fieldPattern 토큰을 사전 항목별 동의어 테이블과 대조하는 순수 규칙 매핑이다.
 *   - 애매하면(복수 후보 또는 무매칭) 미기입으로 스킵하고 리포트에 사유를 남긴다(폴백 유지).
 *   - --write 시에만 scope.fieldKey 를 병합 update(기존 scope·status·큐레이션 메타는 보존).
 *   - fieldKey 가 이미 있는 lesson 은 대상에서 제외한다(덮어쓰지 않음).
 */
import { eq } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { FIELD_KEY_DICTIONARY, isKnownFieldKey } from "./fieldKeyDictionary";
import { listLessons, type LessonScope } from "./knowledgeRepo";

/**
 * 사전 key 별 동의어(fieldPattern 에 등장할 수 있는 표기). 정규화(공백·하이픈·가운뎃점 제거,
 * 대문자화) 후 fieldPattern(정규화)에 부분 문자열로 포함되면 그 key 후보로 본다.
 * 단문자·과잉 일반 토큰(예: 단독 "인")은 과매칭을 유발하므로 넣지 않는다.
 * 정본 의미는 fieldKeyDictionary(기준서 스냅샷) — 여기 동의어는 백필 매핑 전용 보조 사전이다.
 */
const FIELD_KEY_SYNONYMS: Record<string, readonly string[]> = {
  company_name: ["기업명", "상호", "회사명", "업체명", "법인명"],
  biz_reg_no: ["사업자등록번호", "사업자번호", "사업자등록", "사업자 등록"],
  ceo_name: ["대표자성명", "대표자명", "대표이사", "대표자"],
  founded_date: ["설립일", "개업일", "창업일", "설립연월일", "설립년월일"],
  address: ["소재지", "사업장소재지", "본사소재지", "주소"],
  industry: ["업종", "업태", "산업분류"],
  employee_count: [
    "상시근로자",
    "상시고용",
    "직원수",
    "종업원수",
    "근로자수",
    "고용인원",
    "고용현황",
  ],
  revenue: ["매출액", "연매출", "매출규모", "매출"],
  item_summary: ["사업개요", "아이템개요", "사업아이템", "사업내용", "아이템"],
  exec_plan: ["사업추진계획", "추진계획", "실행계획", "추진일정"],
  expected_effect: ["기대효과", "사업효과", "파급효과", "기대성과"],
  budget_table: ["사업비", "예산표", "소요예산", "사업비내역", "예산내역"],
  budget_basis: ["산출근거", "예산산출근거", "비목산출근거", "산출기준"],
  rep_signature: ["대표자서명", "서명날인", "날인", "서명"],
  consent_privacy: ["개인정보동의", "개인정보수집", "개인정보이용", "정보제공동의", "개인정보"],
};

/** 공백·하이픈·가운뎃점 제거 + NFKC + 대문자화(fieldPatternMatchesLabel 과 같은 계열의 정규화). */
function norm(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[\s\-·]/g, "");
}

interface MappingHit {
  key: string;
  synonym: string;
}

/** fieldPattern 에 대해 사전 key 후보를 찾는다(정규화 부분 문자열 포함). */
function proposeFieldKeys(fieldPattern: string): MappingHit[] {
  const patternNorm = norm(fieldPattern);
  const hits: MappingHit[] = [];
  for (const { key } of FIELD_KEY_DICTIONARY) {
    const synonyms = FIELD_KEY_SYNONYMS[key] ?? [];
    for (const synonym of synonyms) {
      const needle = norm(synonym);
      if (needle.length >= 2 && patternNorm.includes(needle)) {
        hits.push({ key, synonym });
        break; // key 당 첫 매칭 동의어만 근거로.
      }
    }
  }
  return hits;
}

type Outcome =
  | { kind: "propose"; key: string; synonym: string }
  | { kind: "skip"; reason: string };

function decide(fieldPattern: string): Outcome {
  const hits = proposeFieldKeys(fieldPattern);
  if (hits.length === 0) return { kind: "skip", reason: "무매칭(사전 동의어 없음)" };
  const uniqueKeys = new Set(hits.map((h) => h.key));
  if (uniqueKeys.size > 1) {
    return { kind: "skip", reason: `복수 후보(${[...uniqueKeys].join(", ")})` };
  }
  const hit = hits[0]!;
  return { kind: "propose", key: hit.key, synonym: hit.synonym };
}

async function main(): Promise<void> {
  const write = process.argv.slice(2).includes("--write");
  const mode = write ? "WRITE" : "DRY-RUN";
  console.log(`lesson fieldKey 백필 (${mode})\n`);

  const all = await listLessons({});
  const targets = all.filter((lesson) => {
    const scope = (lesson.scope ?? {}) as LessonScope;
    const fieldPattern = typeof scope.fieldPattern === "string" ? scope.fieldPattern.trim() : "";
    const fieldKey = typeof scope.fieldKey === "string" ? scope.fieldKey.trim() : "";
    return fieldPattern.length > 0 && fieldKey.length === 0;
  });

  console.log(
    `전체 lesson ${all.length}건 중 대상(fieldPattern 有 · fieldKey 無): ${targets.length}건\n`,
  );

  const proposals: Array<{ id: string; fieldPattern: string; key: string; synonym: string }> = [];
  const skips: Array<{ id: string; fieldPattern: string; reason: string }> = [];

  for (const lesson of targets) {
    const scope = (lesson.scope ?? {}) as LessonScope;
    const fieldPattern = (scope.fieldPattern ?? "").trim();
    const outcome = decide(fieldPattern);
    if (outcome.kind === "propose") {
      proposals.push({ id: lesson.id, fieldPattern, key: outcome.key, synonym: outcome.synonym });
      console.log(
        `  [제안] ${lesson.id}\n         fieldPattern="${fieldPattern}"  →  fieldKey=${outcome.key}  (근거 동의어: "${outcome.synonym}")`,
      );
    } else {
      skips.push({ id: lesson.id, fieldPattern, reason: outcome.reason });
      console.log(`  [스킵] ${lesson.id}\n         fieldPattern="${fieldPattern}"  →  ${outcome.reason}`);
    }
  }

  console.log(`\n요약: 제안 ${proposals.length}건, 스킵 ${skips.length}건.`);

  if (!write) {
    console.log("\n(dry-run — DB 미변경. 반영하려면 -- --write)");
    return;
  }

  // ── --write: 제안 건만 scope.fieldKey 를 병합 update ──────────────────
  const db = getCunoteDb();
  let updated = 0;
  for (const p of proposals) {
    if (!isKnownFieldKey(p.key)) continue; // 방어: 사전 밖 key 는 쓰지 않는다.
    const lesson = targets.find((l) => l.id === p.id);
    if (!lesson) continue;
    const nextScope: LessonScope = { ...((lesson.scope ?? {}) as LessonScope), fieldKey: p.key };
    await db
      .update(schema.reviewLessons)
      .set({ scope: nextScope, updatedAt: new Date() })
      .where(eq(schema.reviewLessons.id, p.id));
    updated += 1;
  }
  console.log(`\n반영 완료: ${updated}건 scope.fieldKey 기입.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
