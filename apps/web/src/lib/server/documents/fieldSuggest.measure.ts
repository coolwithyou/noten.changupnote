/**
 * Phase 4 생성형 필드 제안 실측 스크립트 (Apply Experience v2 · P4-3).
 *
 * 사용:
 *   # 단위(테이블·API 무관): verifySuggestion·manual 제외·merge 불변식·부정 케이스
 *   pnpm measure:field-suggest
 *   # 실 draft E2E(실 Anthropic API 호출 — sonnet, 1회): 제안 생성→basis 실재 검증→suggested 저장→
 *   # accepted 전환→파생 filledFields→buildDraftHwpxDownload 채움 반영 + 교정률 산출 가능성. 변경분 원상 복구.
 *   FIELD_SUGGEST_MEASURE_WITH_API=1 pnpm measure:field-suggest
 *
 * 옵션 env:
 *   FIELD_SUGGEST_DRAFT_ID=<uuid>   대상 draft 고정(미지정 시 서술형 필드 보유 draft 자동 선택)
 *   CHAT_DRAFT_MODEL=...            기본 claude-sonnet-4-6
 *
 * DDL 실행 없음. 시크릿 미출력. DB 쓰기는 suggested 저장·accepted/edited 전환뿐이며 종료 시 원상 복구한다
 * (draft.fieldAnswers/filledFields + 이번 실행이 만든 usage 세션).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §8 Phase 4 P4-3.
 */
import { existsSync, readFileSync } from "node:fs";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb, type CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import {
  generateFieldSuggestions,
  isLlmSuggestableLabel,
  isManualLabel,
  sanitizeSuggestLabels,
  selectDatabaseSuggestableLabels,
  fieldSuggestModel,
  verifySuggestion,
} from "@/lib/server/documents/fieldSuggest";
import {
  deriveFilledFields,
  mergeLlmSuggestions,
  normalizeAnswerLabel,
  resolveFieldAnswers,
  type DraftFieldAnswers,
} from "@/lib/server/documents/fieldAnswers";
import {
  getGrantDocumentDraft,
  patchGrantDocumentDraftFieldAnswers,
} from "@/lib/server/documents/grantDocumentDrafts";
import { buildDraftHwpxDownload, DraftHwpxExportError } from "@/lib/server/documents/draftHwpxExport";
import { loadConnectedDocumentFields, resolveArchiveStorageKey } from "@/lib/server/documents/documentFieldLink";
import { getCompanyDailyTokenUsage } from "@/lib/server/chat/budget";
import { normalizeWs } from "@/lib/server/knowledge/extraction";

function loadEnv() {
  for (const path of [".env.local", "apps/web/.env.local", ".env"]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      const key = rawKey?.trim();
      if (!key || process.env[key] !== undefined) continue;
      let value = rest.join("=").trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

let failures = 0;
function assertTrue(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const ISO = "2026-07-10T00:00:00.000Z";

// ── Part 1: 단위(API·DB 무관) — 검증·제외·불변식·부정 케이스 ──────────────
function unitChecks(): void {
  console.log("\n================ Part 1 · 단위(검증·제외·불변식) ================");

  // manual류 라벨 제외(마스터 8.7 · v2.4).
  assertTrue("manual 제외: '대표자 (서명)'", isManualLabel("대표자 (서명)"));
  assertTrue("manual 제외: '개인정보 수집·이용 동의'", isManualLabel("개인정보 수집·이용 동의"));
  assertTrue("manual 제외: '증빙서류 첨부'", isManualLabel("증빙서류 첨부"));
  assertTrue("민감 식별자 제외: '주민등록번호(대표자)'", isManualLabel("주민등록번호(대표자)"));
  assertTrue("민감 식별자 제외: '여권번호'", isManualLabel("여권번호"));
  assertTrue("서술형 허용: '사업 개요'", isLlmSuggestableLabel("사업 개요"));
  assertTrue("서술형 허용: '창업 아이템 소개'", isLlmSuggestableLabel("창업 아이템 소개"));

  const { eligible, droppedManual } = sanitizeSuggestLabels(["사업 개요", "대표자 (서명)", "사업 개요", ""]);
  assertTrue(
    "sanitize: 중복 제거 + manual 제외",
    eligible.length === 1 && eligible[0] === "사업 개요" && droppedManual.length === 1,
    `eligible=${JSON.stringify(eligible)} dropped=${JSON.stringify(droppedManual)}`,
  );

  const databaseAllowed = selectDatabaseSuggestableLabels([
    { label: "사업 개요", mappedCompanyField: null, fillStrategy: "generate" },
    { label: "주민등록번호(대표자)", mappedCompanyField: null, fillStrategy: "manual" },
    { label: "회사명", mappedCompanyField: "name", fillStrategy: "copy" },
    { label: "중복 항목", mappedCompanyField: null, fillStrategy: "generate" },
    { label: "중복 항목", mappedCompanyField: null, fillStrategy: "manual" },
  ]);
  assertTrue("DB 계획 재대조: generate 필드 허용", databaseAllowed.has("사업 개요"));
  assertTrue("DB 계획 재대조: manual 민감 필드 제외", !databaseAllowed.has("주민등록번호(대표자)"));
  assertTrue("DB 계획 재대조: 프로필 매핑 필드 제외", !databaseAllowed.has("회사명"));
  assertTrue("DB 계획 재대조: 중복 label은 하나라도 manual이면 제외", !databaseAllowed.has("중복 항목"));

  // basis 실재 검증(v2.4) — 그라운딩 코퍼스 부분 문자열 매칭.
  const corpus = normalizeWs("이 사업의 지원 대상은 예비창업자 및 3년 이내 창업기업입니다. 지원금은 최대 5천만원입니다.");

  const passAnnouncement = verifySuggestion(
    { label: "지원 대상", value: "예비창업자 및 3년 이내 창업기업", basis: "공고문 지원 대상", basisKind: "announcement", evidenceQuote: "지원 대상은 예비창업자 및 3년 이내 창업기업" },
    corpus,
  );
  assertTrue("basis 실재 통과(announcement, 코퍼스에 존재)", passAnnouncement !== null, JSON.stringify(passAnnouncement));

  const failAnnouncement = verifySuggestion(
    { label: "지원 대상", value: "지어낸 값", basis: "공고문(허위)", basisKind: "announcement", evidenceQuote: "이 문장은 공고문에 존재하지 않는 지어낸 근거입니다" },
    corpus,
  );
  assertTrue("[부정] basis 실재 불통과(announcement, 코퍼스에 없음) → 폐기", failAnnouncement === null);

  const noBasis = verifySuggestion(
    { label: "사업 개요", value: "값만 있음", basis: "", basisKind: "profile", evidenceQuote: "" },
    corpus,
  );
  assertTrue("[부정] basis 없는 제안 → 폐기", noBasis === null);

  const profileOk = verifySuggestion(
    { label: "상시근로자 수", value: "5명", basis: "회사 프로필(상시근로자)", basisKind: "profile", evidenceQuote: "" },
    corpus,
  );
  assertTrue("profile 유래 basis 는 실재 검증 대상 아님 → 통과", profileOk !== null);

  // merge 불변식: 확정/기각 보존 · basis 없는 제안 미저장 · suggested 갱신.
  const current: DraftFieldAnswers = {
    확정필드: { value: "확정값", status: "accepted", source: "llm", suggestedValue: "구제안", basis: "b", updatedAt: ISO },
    제안필드: { value: "옛 제안", status: "suggested", source: "llm", suggestedValue: "옛 제안", basis: "b", updatedAt: ISO },
  };
  const merged = mergeLlmSuggestions(
    current,
    {
      확정필드: { value: "덮어쓰기 시도", basis: "b2" },
      제안필드: { value: "새 제안", basis: "b3" },
      바시스없음: { value: "값", basis: "" },
    },
    { at: ISO },
  );
  assertTrue("merge: accepted 불변(제안이 덮어쓰지 못함)", merged.확정필드?.value === "확정값" && merged.확정필드?.status === "accepted");
  assertTrue("merge: 기존 suggested 는 새 제안으로 갱신", merged.제안필드?.value === "새 제안" && merged.제안필드?.source === "llm");
  assertTrue("merge: basis 없는 제안은 저장 안 됨", !("바시스없음" in merged));
  const mergedFilled = deriveFilledFields(merged);
  assertTrue(
    "merge: suggested(llm) 제안은 파생 filledFields 미포함(accepted 만 포함)",
    !("제안필드" in mergedFilled) && mergedFilled.확정필드 === "확정값",
    JSON.stringify(mergedFilled),
  );
}

// ── Part 2: 실 draft E2E(실 API) ──────────────────────────────────────
interface Candidate {
  draftId: string;
  companyId: string;
  userId: string;
  grantId: string;
  /**
   * 제안을 시도할 라벨 후보(≤ 10). 모델이 근거를 댈 수 있는 것만 실제로 저장·반환된다 — e2e 는 그중 첫
   * 성공 라벨로 이후 accept·채움·교정 사슬을 잇는다. 연결필드 경로는 1건, 양식셀 폴백은 여러 건을 싣는다.
   */
  labels: string[];
  /**
   * true 면 라벨이 grant_document_fields 가 아니라 **실 HWPX 양식의 실제 채움 셀**에서 왔음을 뜻한다
   * (이 DB 는 필드 추출 데이터가 없어 — §2.2 검수 병목 — 양식 셀을 근거로 진짜 '채움 반영'을 실측한다).
   * 이 경우 e2e 가 해당 라벨들을 임시로 비운 뒤(컨펌 게이트가 스킵하지 않도록) 제안을 생성한다(종료 시 복구).
   */
  fromTemplateCell: boolean;
}

/**
 * 실 HWPX 양식에서 채움 셀 label 을 얻는다(필드 추출 데이터 부재 시 폴백).
 * buildDraftHwpxDownload 를 draft 원상태로 1회 돌려 filled(=실제 매칭된 셀 label) 중 manual 아닌 것들 —
 * 값이 긴(서술형에 가까운) 순으로 상위 6개를 싣는다(공고 메타·프로필로 근거를 댈 수 있는 셀이 하나라도 있게).
 * R2/양식 미가용 draft 는 건너뛴다.
 */
async function findTemplateCellCandidate(
  db: CunoteDb,
  draftRows: Array<{ id: string; companyId: string; userId: string; grantId: string; sourceAttachment: string | null }>,
): Promise<Candidate | null> {
  let attempts = 0;
  for (const draft of draftRows) {
    if (!draft.sourceAttachment) continue;
    if (attempts >= 12) break;
    attempts += 1;
    const access: CompanyAccess = {
      companyId: draft.companyId,
      userId: draft.userId,
      role: "owner" as const,
      mode: "session" as const,
    } as CompanyAccess;
    try {
      const draftRow = await getGrantDocumentDraft({ draftId: draft.id, access });
      const download = await buildDraftHwpxDownload({ draft: draftRow });
      const labels = download.filled
        .filter((f) => isLlmSuggestableLabel(f.label) && f.value.trim().length > 0)
        .sort((a, b) => b.value.length - a.value.length)
        .map((f) => f.label)
        .filter((label, index, arr) => arr.indexOf(label) === index)
        .slice(0, 6);
      if (labels.length > 0) {
        return {
          draftId: draft.id,
          companyId: draft.companyId,
          userId: draft.userId,
          grantId: draft.grantId,
          labels,
          fromTemplateCell: true,
        };
      }
    } catch {
      // R2 미설정·hwpx 미준비·위장 파일 등 — 다음 draft 로.
    }
  }
  return null;
}

async function pickCandidate(db: CunoteDb): Promise<Candidate | null> {
  const fixed = process.env.FIELD_SUGGEST_DRAFT_ID?.trim();
  const draftRows = fixed
    ? await db
        .select({
          id: schema.grantDocumentDrafts.id,
          companyId: schema.grantDocumentDrafts.companyId,
          userId: schema.grantDocumentDrafts.userId,
          grantId: schema.grantDocumentDrafts.grantId,
          sourceAttachment: schema.grantDocumentDrafts.sourceAttachment,
        })
        .from(schema.grantDocumentDrafts)
        .where(eq(schema.grantDocumentDrafts.id, fixed))
        .limit(1)
    : await db
        .select({
          id: schema.grantDocumentDrafts.id,
          companyId: schema.grantDocumentDrafts.companyId,
          userId: schema.grantDocumentDrafts.userId,
          grantId: schema.grantDocumentDrafts.grantId,
          sourceAttachment: schema.grantDocumentDrafts.sourceAttachment,
        })
        .from(schema.grantDocumentDrafts)
        .where(isNotNull(schema.grantDocumentDrafts.sourceAttachment))
        .orderBy(desc(schema.grantDocumentDrafts.updatedAt))
        .limit(40);

  // markdown 그라운딩 보유 공고를 우선(공고문 유래 basis 실재 검증이 통과할 여지가 큼). 없으면 폴백.
  let fallback: Candidate | null = null;
  for (const draft of draftRows) {
    if (!draft.sourceAttachment) continue;
    const grantRows = await db
      .select({ source: schema.grants.source, sourceId: schema.grants.sourceId })
      .from(schema.grants)
      .where(eq(schema.grants.id, draft.grantId))
      .limit(1);
    const grant = grantRows[0];
    if (!grant) continue;
    let storageKey: string | null = null;
    try {
      const archive = await resolveArchiveStorageKey({
        source: grant.source,
        sourceId: grant.sourceId,
        filename: draft.sourceAttachment,
      });
      storageKey = archive?.storageKey ?? null;
    } catch {
      storageKey = null;
    }
    const fields = await loadConnectedDocumentFields({
      source: grant.source,
      sourceId: grant.sourceId,
      sourceAttachment: storageKey ?? draft.sourceAttachment,
    });
    const narrative = fields.find(
      (field) => !field.mappedCompanyField && isLlmSuggestableLabel(field.label),
    );
    if (!narrative) continue;
    const candidate: Candidate = {
      draftId: draft.id,
      companyId: draft.companyId,
      userId: draft.userId,
      grantId: draft.grantId,
      labels: [narrative.label],
      fromTemplateCell: false,
    };
    const markdownRows = await db
      .select({ key: schema.grantAttachmentArchives.markdownStorageKey })
      .from(schema.grantAttachmentArchives)
      .where(
        and(
          eq(schema.grantAttachmentArchives.source, grant.source),
          eq(schema.grantAttachmentArchives.sourceId, grant.sourceId),
          isNotNull(schema.grantAttachmentArchives.markdownStorageKey),
        ),
      )
      .limit(1);
    if (markdownRows.length > 0) return candidate; // 그라운딩 풍부 — 즉시 채택.
    if (!fallback) fallback = candidate;
    if (fixed) return candidate; // 고정 지정이면 그대로.
  }
  if (fallback) return fallback;
  // grant_document_fields 부재(§2.2 검수 병목) → 실 HWPX 양식 셀에서 채움 라벨을 얻는 폴백.
  return findTemplateCellCandidate(db, draftRows);
}

async function e2e(db: CunoteDb): Promise<void> {
  console.log("\n================ Part 2 · 실 draft E2E(실 API) ================");
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.log("  [skip] ANTHROPIC_API_KEY 없음 — E2E 생략");
    return;
  }
  const candidate = await pickCandidate(db);
  if (!candidate) {
    console.log("  [중단] 서술형(제안 대상) 필드를 가진 draft 를 찾지 못함. FIELD_SUGGEST_DRAFT_ID 로 지정하세요.");
    failures += 1;
    return;
  }
  const access: CompanyAccess = {
    companyId: candidate.companyId,
    userId: candidate.userId,
    role: "owner" as const,
    mode: "session" as const,
  } as CompanyAccess;
  console.log(
    `  대상 draft=${candidate.draftId} grant=${candidate.grantId} labels=${JSON.stringify(candidate.labels)} ` +
      `source=${candidate.fromTemplateCell ? "HWPX양식셀" : "연결필드"} model=${fieldSuggestModel()}`,
  );

  // 스냅샷(원상 복구용): draft 값 + 오늘 usage 세션 상태.
  const [origRow] = await db
    .select({
      fieldAnswers: schema.grantDocumentDrafts.fieldAnswers,
      filledFields: schema.grantDocumentDrafts.filledFields,
    })
    .from(schema.grantDocumentDrafts)
    .where(eq(schema.grantDocumentDrafts.id, candidate.draftId))
    .limit(1);
  const sessionSnapshot = await snapshotSessions(db, candidate.companyId, candidate.grantId);
  const usageBefore = await getCompanyDailyTokenUsage(db, candidate.companyId);

  try {
    // 양식 셀 폴백이면 대상 라벨들을 임시로 비운다(컨펌 게이트가 accepted 를 스킵하지 않도록 — 종료 시 복구).
    if (candidate.fromTemplateCell && origRow) {
      const cleared = resolveFieldAnswers({
        fieldAnswers: origRow.fieldAnswers ?? null,
        filledFields: origRow.filledFields ?? {},
      });
      for (const label of candidate.labels) delete cleared[normalizeAnswerLabel(label)];
      await db
        .update(schema.grantDocumentDrafts)
        .set({ fieldAnswers: cleared, filledFields: deriveFilledFields(cleared), updatedAt: new Date() })
        .where(eq(schema.grantDocumentDrafts.id, candidate.draftId));
    }

    // ① 제안 생성(실 API 1회) → basis 실재 검증 통과분만 저장→반환.
    const result = await generateFieldSuggestions({
      draftId: candidate.draftId,
      access,
      labels: candidate.labels,
      mode: "generate",
    });
    // 모델이 근거를 댈 수 있어 실제 반환된 첫 라벨을 대상으로 삼는다.
    const targetLabel = candidate.labels.find((label) => result.suggestions[label]?.value) ?? null;
    const suggestion = targetLabel ? result.suggestions[targetLabel] : undefined;
    console.log(
      `  근거 통과 제안 ${Object.keys(result.suggestions).length}/${candidate.labels.length}건. ` +
        `대상="${targetLabel ?? "(없음)"}" value=${JSON.stringify(suggestion?.value?.slice(0, 100))} basis=${JSON.stringify(suggestion?.basis?.slice(0, 80))}`,
    );
    assertTrue(
      "① 제안 생성 + basis 동반(basis 없는/불통과 미반환)",
      Boolean(suggestion?.value && suggestion?.basis),
      targetLabel ? "" : "근거 통과 제안 0건 — 그라운딩이 빈약한 draft(FIELD_SUGGEST_DRAFT_ID 로 markdown 보유 공고 지정 권장)",
    );

    // ③ 예산 합산: 제안 usage 가 당일 합산에 반영됨(ADR-6).
    const usageAfter = await getCompanyDailyTokenUsage(db, candidate.companyId);
    assertTrue("③ 제안 usage 당일 합산 증가", usageAfter > usageBefore, `${usageBefore} → ${usageAfter}`);

    if (!targetLabel || !suggestion?.value) {
      console.log("  [중단] 근거 통과 제안이 없어 이후 단계 생략");
      return;
    }
    const key = normalizeAnswerLabel(targetLabel);

    // ② 저장 확인: fieldAnswers 에 suggested/llm 로 저장(저장-반환 일치).
    const afterGen = await getGrantDocumentDraft({ draftId: candidate.draftId, access });
    const saved = afterGen.fieldAnswers?.[key];
    assertTrue(
      "② suggested/llm 저장(suggestedValue·basis 보존)",
      saved?.status === "suggested" && saved?.source === "llm" && Boolean(saved?.basis) && saved?.suggestedValue === saved?.value,
      `status=${saved?.status} source=${saved?.source}`,
    );
    assertTrue("② suggested 는 파생 filledFields 미포함(컨펌 게이트)", !(targetLabel in (afterGen.filledFields ?? {})));

    // ④ accepted 전환(함수 레벨) → 파생 filledFields 포함.
    const accepted = await patchGrantDocumentDraftFieldAnswers({
      draftId: candidate.draftId,
      access,
      answers: { [key]: { status: "accepted" } },
    });
    assertTrue(
      "④ accepted 전환 → filledFields 포함",
      accepted.filledFields[targetLabel] === suggestion.value || accepted.filledFields[key] === suggestion.value,
      `filled=${JSON.stringify(accepted.filledFields[targetLabel] ?? accepted.filledFields[key])?.slice(0, 80)}`,
    );

    // ⑤ buildDraftHwpxDownload 채움 반영(원본 양식에 값이 들어가는지).
    const draftForFill = await getGrantDocumentDraft({ draftId: candidate.draftId, access });
    try {
      const download = await buildDraftHwpxDownload({ draft: draftForFill });
      const filledEntry = download.filled.find((f) => f.label === targetLabel || normalizeAnswerLabel(f.label) === key);
      console.log(`  HWPX: filled=${download.filled.length} unfilled=${download.unfilled.length} 대상채움=${filledEntry ? "예" : "아니오"} bytes=${download.body.length}`);
      assertTrue("⑤ HWPX 채움에 accepted 값 반영", Boolean(filledEntry && filledEntry.value === suggestion.value));
    } catch (error) {
      if (error instanceof DraftHwpxExportError) {
        console.log(`  [HWPX 소프트 스킵] ${error.code}: ${error.message}`);
        console.log("  (환경 의존 — 원본 양식/R2 미가용. accepted→filledFields 파생은 ④에서 확인됨.)");
      } else {
        throw error;
      }
    }

    // ⑥ 교정률 산출 가능성: edited 로 값 수정 → suggestedValue vs value diff.
    const editedValue = `${suggestion.value} (교정)`;
    const edited = await patchGrantDocumentDraftFieldAnswers({
      draftId: candidate.draftId,
      access,
      answers: { [key]: { value: editedValue, status: "edited" } },
    });
    const editedEntry = edited.fieldAnswers[key];
    const correctionMeasurable = Boolean(
      editedEntry && editedEntry.suggestedValue !== undefined && editedEntry.suggestedValue !== editedEntry.value,
    );
    assertTrue(
      "⑥ 교정률 산출 가능(suggestedValue ≠ value diff)",
      correctionMeasurable,
      `suggested=${JSON.stringify(editedEntry?.suggestedValue?.slice(0, 40))} value=${JSON.stringify(editedEntry?.value?.slice(0, 40))}`,
    );
  } finally {
    // 원상 복구: draft 값 + 이번 실행이 만든/변경한 usage 세션.
    await db
      .update(schema.grantDocumentDrafts)
      .set({
        fieldAnswers: origRow?.fieldAnswers ?? null,
        filledFields: origRow?.filledFields ?? {},
        updatedAt: new Date(),
      })
      .where(eq(schema.grantDocumentDrafts.id, candidate.draftId));
    await restoreSessions(db, candidate.companyId, candidate.grantId, sessionSnapshot);
    console.log("  ↺ draft·usage 세션 원상 복구 완료");
  }
}

// 오늘(KST) 회사·공고 세션 스냅샷(id → usage). 복구 시 신규 행 삭제 + 기존 행 usage 되돌림.
async function snapshotSessions(
  db: CunoteDb,
  companyId: string,
  grantId: string,
): Promise<Map<string, { i: number; o: number; cr: number; cw: number }>> {
  const rows = (await db.execute(sql`
    SELECT id, input_tokens AS i, output_tokens AS o, cache_read_tokens AS cr, cache_write_tokens AS cw
    FROM chat_sessions
    WHERE company_id = ${companyId} AND grant_id = ${grantId}
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
  `)) as unknown as Array<{ id: string; i: number; o: number; cr: number; cw: number }>;
  const map = new Map<string, { i: number; o: number; cr: number; cw: number }>();
  for (const r of rows) map.set(r.id, { i: Number(r.i), o: Number(r.o), cr: Number(r.cr), cw: Number(r.cw) });
  return map;
}

async function restoreSessions(
  db: CunoteDb,
  companyId: string,
  grantId: string,
  snapshot: Map<string, { i: number; o: number; cr: number; cw: number }>,
): Promise<void> {
  const after = await snapshotSessions(db, companyId, grantId);
  for (const [id] of after) {
    const before = snapshot.get(id);
    if (!before) {
      // 이번 실행이 만든 세션 → 삭제.
      await db.delete(schema.chatSessions).where(eq(schema.chatSessions.id, id));
    } else {
      // 기존 세션의 usage 를 실행 전 값으로 되돌림.
      await db
        .update(schema.chatSessions)
        .set({
          inputTokens: before.i,
          outputTokens: before.o,
          cacheReadTokens: before.cr,
          cacheWriteTokens: before.cw,
        })
        .where(and(eq(schema.chatSessions.id, id), eq(schema.chatSessions.companyId, companyId)));
    }
  }
}

async function main() {
  loadEnv();
  const withApi = process.env.FIELD_SUGGEST_MEASURE_WITH_API === "1";
  console.log(`# P4-3 measure:field-suggest | model=${fieldSuggestModel()} | withApi=${withApi}`);
  unitChecks();
  const db = getCunoteDb();
  try {
    if (withApi) {
      await e2e(db);
    } else {
      console.log("\n[Part 2 생략] FIELD_SUGGEST_MEASURE_WITH_API=1 로 실 draft E2E(실 API·복구) 실행.");
    }
  } finally {
    await closeCunoteDb();
  }
  console.log(`\n# 완료 — 실패 ${failures}건`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[measure:field-suggest 오류]", error);
  process.exitCode = 1;
});
