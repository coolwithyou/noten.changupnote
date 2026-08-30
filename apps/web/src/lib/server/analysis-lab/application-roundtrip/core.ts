import { createHash } from "node:crypto";
import { extractFormSchema, inferFieldType, type FormFieldSchema, type IRBlock, type IRCell } from "kordoc";
import type {
  RoundtripDocumentRole,
  RoundtripFieldCandidate,
  RoundtripFieldInputKind,
  RoundtripFieldType,
  RoundtripRoleScores,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";

const APPLICATION_FILENAME = /(신청서|지원서|참가신청|입주신청|등록신청|신청양식|제출서류)/i;
const PLAN_FILENAME = /(사업\s*계획서|수행\s*계획서|제안서|발표자료|사업계획)/i;
const ANNOUNCEMENT_FILENAME = /(공고문|모집공고|모집요강|사업공고|공고서|안내문|시행계획)/i;
const EVIDENCE_FILENAME = /(동의서|서약서|확약서|협약서|증빙|체크리스트|개인정보|위임장|명부)/i;
const FOLLOWUP_REPORT_FILENAME = /((결과|정산|실적|완료|중간)\s*보고서|성과\s*보고서)/i;
const GUIDANCE_FILENAME = /(관리\s*지침|운영\s*지침|업무\s*지침|운영\s*요령|공통\s*요령|관련\s*법령|시행\s*(?:령|규칙)|운영\s*규정|공통\s*규정|법(?=[\s._()\[\]-]|$)|가이드라인|매뉴얼)/i;

const APPLICATION_BODY = /(신청인|신청기업|신청자|대표자\s*(성명|명)|담당자|연락처|사업자등록번호|접수번호)/gi;
const PLAN_BODY = /(사업개요|창업아이템|문제인식|실현가능성|성장전략|시장현황|추진계획|사업화\s*계획|자금조달|수익모델)/gi;
const ANNOUNCEMENT_BODY = /(공고\s*제\s*\d+호|모집\s*공고|신청기간|지원대상|선정절차|유의사항)/gi;
const EVIDENCE_BODY = /(개인정보\s*수집|서약합니다|확약합니다|동의합니다|증빙서류)/gi;

export interface RoleClassification {
  role: RoundtripDocumentRole;
  confidence: number;
  scores: RoundtripRoleScores;
  signals: string[];
}

export function classifyRoundtripDocument(input: {
  filename: string;
  markdown: string;
  fields: RoundtripFieldCandidate[];
  formConfidence: number;
}): RoleClassification {
  const scores: RoundtripRoleScores = {
    applicationForm: 0,
    businessPlan: 0,
    announcement: 0,
    evidence: 0,
  };
  const signals: string[] = [];

  addFilenameSignal(input.filename, APPLICATION_FILENAME, "파일명에 신청·지원서 표현", scores, "applicationForm", 5, signals);
  addFilenameSignal(input.filename, PLAN_FILENAME, "파일명에 사업·수행계획서 표현", scores, "businessPlan", 6, signals);
  addFilenameSignal(input.filename, ANNOUNCEMENT_FILENAME, "파일명에 공고문 표현", scores, "announcement", 6, signals);
  addFilenameSignal(input.filename, EVIDENCE_FILENAME, "파일명에 동의·증빙서류 표현", scores, "evidence", 5, signals);
  if (
    EVIDENCE_FILENAME.test(input.filename)
    && !APPLICATION_FILENAME.test(input.filename)
    && !PLAN_FILENAME.test(input.filename)
  ) {
    scores.evidence += 12;
    signals.push("파일명이 독립 동의·증빙서류임");
  }
  if (
    FOLLOWUP_REPORT_FILENAME.test(input.filename)
    && !APPLICATION_FILENAME.test(input.filename)
    && !PLAN_FILENAME.test(input.filename)
  ) {
    scores.announcement += 12;
    signals.push("파일명이 선정 이후 결과·정산 보고서임");
  }
  if (
    GUIDANCE_FILENAME.test(input.filename)
    && !APPLICATION_FILENAME.test(input.filename)
    && !PLAN_FILENAME.test(input.filename)
  ) {
    // 관리지침에는 신청자·사업계획·증빙 표현과 빈 표가 대량 포함될 수 있지만,
    // 별도 신청 양식이 아닌 정책 문서를 빠른 작성 대상으로 보내면 수천 후보를
    // LLM이 판정하게 된다. 파일명이 신청서/계획서를 함께 명시한 경우만 예외로 둔다.
    scores.announcement += 12;
    signals.push("파일명에 독립 관리·운영지침 표현");
  }

  const body = input.markdown.slice(0, 80_000);
  const applicationHits = matchCount(body, APPLICATION_BODY);
  const planHits = matchCount(body, PLAN_BODY);
  const announcementHits = matchCount(body, ANNOUNCEMENT_BODY);
  const evidenceHits = matchCount(body, EVIDENCE_BODY);
  if (applicationHits > 0) {
    scores.applicationForm += Math.min(4, applicationHits * 0.75);
    signals.push(`본문 신청정보 표현 ${applicationHits}회`);
  }
  if (planHits > 0) {
    scores.businessPlan += Math.min(6, planHits * 0.9);
    signals.push(`본문 사업계획 목차 표현 ${planHits}회`);
  }
  if (announcementHits > 0) {
    scores.announcement += Math.min(4, announcementHits * 0.5);
    signals.push(`본문 공고 안내 표현 ${announcementHits}회`);
  }
  if (evidenceHits > 0) {
    scores.evidence += Math.min(4, evidenceHits * 0.8);
    signals.push(`본문 동의·증빙 표현 ${evidenceHits}회`);
  }

  const emptyCount = input.fields.filter((field) => field.empty).length;
  const recommendedCount = input.fields.filter((field) => field.empty && field.recommendedInput).length;
  if (recommendedCount >= 3) {
    const bonus = Math.min(5, 1 + recommendedCount / 12);
    scores.applicationForm += bonus;
    signals.push(`Kordoc 사용자 입력 후보 ${recommendedCount}개 (raw 빈 셀 ${emptyCount}개)`);
  }
  if (input.formConfidence >= 0.25) {
    scores.applicationForm += Math.min(2, input.formConfidence * 2);
    signals.push(`Kordoc 양식 확신도 ${input.formConfidence.toFixed(2)}`);
  }

  const ranked = [
    ["application_form", scores.applicationForm] as const,
    ["business_plan", scores.businessPlan] as const,
    ["announcement", scores.announcement] as const,
    ["evidence", scores.evidence] as const,
  ].sort((a, b) => b[1] - a[1]);
  const best = ranked[0] ?? ["unknown", 0] as const;
  const second = ranked[1]?.[1] ?? 0;

  let role: RoundtripDocumentRole = best[1] >= 3 ? best[0] : "unknown";
  if (
    scores.applicationForm >= 4 &&
    scores.businessPlan >= 4 &&
    Math.abs(scores.applicationForm - scores.businessPlan) <= 3
  ) {
    role = "mixed_form";
    signals.push("신청서와 사업계획서 신호가 함께 존재");
  }
  const confidence = role === "unknown"
    ? 0.2
    : clamp(0.45 + (best[1] - second) * 0.06 + Math.min(best[1], 10) * 0.025, 0.45, 0.98);
  return { role, confidence, scores, signals: signals.slice(0, 8) };
}

function addFilenameSignal(
  filename: string,
  pattern: RegExp,
  signal: string,
  scores: RoundtripRoleScores,
  key: keyof RoundtripRoleScores,
  value: number,
  signals: string[],
): void {
  if (!pattern.test(filename)) return;
  scores[key] += value;
  signals.push(signal);
}

function matchCount(value: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return [...value.matchAll(pattern)].length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeRoundtripLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[※*★]/g, "")
    .replace(/\(필수\)|\[필수\]/g, "")
    .replace(/[\s:：·ㆍ._\-()\[\]{}<>「」『』]/g, "")
    .toLowerCase();
}

export function extractLocatedRoundtripFields(
  blocks: IRBlock[],
  sourceSha256: string,
): { fields: RoundtripFieldCandidate[]; formConfidence: number } {
  const fields: RoundtripFieldCandidate[] = [];
  const occurrences = new Map<string, number>();
  const confidenceSamples: number[] = [];

  blocks.forEach((block, blockIndex) => {
    if (block.type !== "table" || !block.table) return;
    const schema = extractFormSchema([block]);
    confidenceSamples.push(schema.confidence);
    for (const field of schema.fields) {
      const label = field.label.trim();
      const normalizedLabel = normalizeRoundtripLabel(label);
      if (!normalizedLabel) continue;
      const occurrence = occurrences.get(normalizedLabel) ?? 0;
      occurrences.set(normalizedLabel, occurrence + 1);
      const fieldInstanceId = createHash("sha256")
        .update(`${sourceSha256}:${blockIndex}:${field.row}:${field.col}:${occurrence}:${normalizedLabel}`)
        .digest("hex")
        .slice(0, 24);
      const sample = generateRoundtripSampleValue(field);
      const inputAssessment = assessRoundtripInputField({
        label,
        type: field.type,
        row: field.row,
        required: field.required ?? false,
      });
      const narrativePlaceholder = isNarrativeInstructionPlaceholder(label, field.value);
      const fixedCellPlaceholder = !field.empty
        && inputAssessment.recommended
        && isWritableStructuralPlaceholder(field.value);
      const empty = field.empty || narrativePlaceholder || fixedCellPlaceholder;
      fields.push({
        fieldInstanceId,
        label,
        displayLabel: label,
        normalizedLabel,
        originalValue: field.value,
        type: field.type,
        required: field.required ?? false,
        empty,
        recommendedInput: empty && inputAssessment.recommended,
        inputLikelihood: inputAssessment.likelihood,
        inputSignals: [
          ...inputAssessment.signals,
          ...(narrativePlaceholder ? ["작성 안내문이 있는 장문 입력 셀"] : []),
          ...(fixedCellPlaceholder ? ["입력 셀에 남아 있는 고정 양식 placeholder"] : []),
        ],
        sampleValue: sample.value,
        sampleReason: sample.reason,
        source: "kordoc-form",
        inputKind: narrativePlaceholder ? "textarea" : inferRoundtripInputKind(label, field.type),
        writeOperation: "kordoc_field",
        helperText: field.value.trim() && (!field.empty || narrativePlaceholder || fixedCellPlaceholder)
          ? field.value.trim()
          : null,
        unit: null,
        options: [],
        analysisSource: "heuristic",
        llmConfidence: null,
        location: {
          blockIndex,
          row: field.row,
          col: field.col,
          occurrence,
          pageNumber: block.pageNumber ?? null,
        },
      });
    }
  });

  const formConfidence = confidenceSamples.length > 0
    ? confidenceSamples.reduce((sum, value) => sum + value, 0) / confidenceSamples.length
    : 0;
  const structuralOccurrences = buildStructuralLabelOccurrences(blocks);
  fields.push(...extractRhwpStructuralFields(blocks, sourceSha256, fields, structuralOccurrences));
  for (const field of fields) {
    if (field.source === "contextual-region") continue;
    const observed = structuralOccurrences.get(structuralLocationKey(
      field.location.blockIndex,
      field.location.row,
      field.location.col,
    ));
    if (observed?.normalizedLabel === field.normalizedLabel) {
      field.location.occurrence = observed.occurrence;
    }
  }
  suppressValueCellDuplicates(fields);
  return { fields, formConfidence };
}

interface StructuralLabelOccurrence {
  normalizedLabel: string;
  occurrence: number;
}

/**
 * KorDoc의 label-value 추출기는 병합된 행의 오른쪽 끝 라벨이나 `/` 같은 값 placeholder를
 * 후보로 만들지 못할 수 있다. RHWP는 원문 라벨에서 native 표 셀을 다시 exact하게 찾으므로,
 * 고신호 라벨과 쓰기 가능한 오른쪽 구조가 함께 있는 경우만 RHWP 전용 후보로 보강한다.
 */
export function extractRhwpStructuralFields(
  blocks: IRBlock[],
  sourceSha256: string,
  existingFields: readonly RoundtripFieldCandidate[] = [],
  occurrences = buildStructuralLabelOccurrences(blocks),
): RoundtripFieldCandidate[] {
  const existing = new Set(existingFields.map((field) => structuralCandidateKey(
    field.location.blockIndex,
    field.location.row,
    field.normalizedLabel,
  )));
  const recovered: RoundtripFieldCandidate[] = [];

  blocks.forEach((block, blockIndex) => {
    if (block.type !== "table" || !block.table) return;
    block.table.cells.forEach((row, rowIndex) => {
      row.forEach((cell, colIndex) => {
        const label = cell.text.trim();
        const normalizedLabel = normalizeRoundtripLabel(label);
        if (
          !normalizedLabel
          || !isRhwpStructuralInputLabel(label)
          || existing.has(structuralCandidateKey(blockIndex, rowIndex, normalizedLabel))
        ) return;
        const target = structuralValueEvidence(row, colIndex, cell);
        if (!target) return;
        const type = inferFieldType(label, target.value);
        const inputAssessment = assessRoundtripInputField({ label, type, row: rowIndex });
        if (!inputAssessment.recommended) return;
        const observed = occurrences.get(structuralLocationKey(blockIndex, rowIndex, colIndex));
        const sample = generateRoundtripSampleValue({ label, type });
        recovered.push({
          fieldInstanceId: createHash("sha256")
            .update(`${sourceSha256}:rhwp:${blockIndex}:${rowIndex}:${colIndex}:${normalizedLabel}`)
            .digest("hex")
            .slice(0, 24),
          label,
          displayLabel: label,
          normalizedLabel,
          originalValue: target.value,
          type,
          required: false,
          empty: true,
          recommendedInput: true,
          inputLikelihood: inputAssessment.likelihood,
          inputSignals: [
            ...inputAssessment.signals,
            target.implicit ? "병합 표 오른쪽 끝의 RHWP 입력칸" : "RHWP 라벨 오른쪽의 빈 값 셀",
            "KorDoc label-value 후보 누락 보강",
          ],
          sampleValue: sample.value,
          sampleReason: sample.reason,
          source: "rhwp-structural",
          inputKind: inferRoundtripInputKind(label, type),
          writeOperation: "rhwp_field",
          helperText: `문서의 ‘${label.replace(/\s+/gu, " ")}’ 입력칸에 기재합니다.`,
          unit: null,
          options: [],
          analysisSource: "heuristic",
          llmConfidence: null,
          location: {
            blockIndex,
            row: rowIndex,
            col: colIndex,
            occurrence: observed?.occurrence ?? 0,
            pageNumber: block.pageNumber ?? null,
          },
        });
        suppressStructuralPlaceholderCandidate(existingFields, {
          blockIndex,
          rowIndex,
          label,
          targetCol: target.targetCol,
          targetValue: target.value,
        });
        existing.add(structuralCandidateKey(blockIndex, rowIndex, normalizedLabel));
      });
    });
  });
  return recovered;
}

function structuralValueEvidence(
  row: readonly IRCell[],
  colIndex: number,
  labelCell: IRCell,
): { value: string; implicit: boolean; targetCol: number } | null {
  const targetIndex = colIndex + Math.max(1, labelCell.colSpan);
  const target = row[targetIndex];
  if (target && isWritableStructuralPlaceholder(target.text)) {
    return { value: target.text.trim(), implicit: false, targetCol: targetIndex };
  }
  // 일부 HWPX 병합 표는 오른쪽 값 셀을 logical grid에서 생략하지만 native RHWP 표에는
  // 별도 셀로 남긴다. 행 끝을 넘어가는 라벨만 이 보강을 허용해 일반 머리글 오탐을 줄인다.
  if (targetIndex >= row.length) return { value: "", implicit: true, targetCol: targetIndex };
  return null;
}

function isWritableStructuralPlaceholder(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return normalized.length === 0
    || /^(?:[/＿_\-.·ㆍ]|\(\s*\))+$/u.test(normalized)
    || /^\([^)]{2,40}\)$/u.test(normalized)
    || /^금\s*:\s*(?:백\s*만\s*원|만\s*원|원)?$/u.test(normalized)
    || /^(?:은행\s*)?지점\s*\(\s*담당자[^)]{0,30}\)$/u.test(normalized);
}

function suppressStructuralPlaceholderCandidate(
  fields: readonly RoundtripFieldCandidate[],
  owner: {
    blockIndex: number;
    rowIndex: number;
    label: string;
    targetCol: number;
    targetValue: string;
  },
): void {
  const targetLabel = normalizeRoundtripLabel(owner.targetValue);
  if (!targetLabel) return;
  for (const field of fields) {
    if (
      field.source !== "kordoc-form"
      || field.location.blockIndex !== owner.blockIndex
      || field.location.row !== owner.rowIndex
      || field.location.col !== owner.targetCol
      || field.normalizedLabel !== targetLabel
    ) continue;
    field.recommendedInput = false;
    field.inputLikelihood = Math.min(field.inputLikelihood, 0.1);
    field.inputSignals.push(`RHWP 구조가 더 구체적인 “${owner.label.replace(/\s+/gu, " ")}” 입력으로 대체`);
  }
}

/** 행 끝 보강은 짧은 필드 라벨에만 적용하고 선택지·서명문·조례 본문은 후보로 만들지 않는다. */
function isRhwpStructuralInputLabel(value: string): boolean {
  const compact = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (compact.length < 2 || compact.length > 60) return false;
  if ((value.match(/\n/gu) ?? []).length > 2) return false;
  if (/[□☐■☑✓]/u.test(value)) return false;
  return !/(?:본인은|조례|규칙|다짐|감수|귀하|제출합니다|신청합니다|동의합니다)/u.test(compact);
}

function buildStructuralLabelOccurrences(blocks: readonly IRBlock[]): Map<string, StructuralLabelOccurrence> {
  const result = new Map<string, StructuralLabelOccurrence>();
  const counts = new Map<string, number>();
  blocks.forEach((block, blockIndex) => {
    if (block.type !== "table" || !block.table) return;
    block.table.cells.forEach((row, rowIndex) => {
      row.forEach((cell, colIndex) => {
        const normalizedLabel = normalizeRoundtripLabel(cell.text);
        if (!normalizedLabel) return;
        const occurrence = counts.get(normalizedLabel) ?? 0;
        counts.set(normalizedLabel, occurrence + 1);
        result.set(structuralLocationKey(blockIndex, rowIndex, colIndex), { normalizedLabel, occurrence });
      });
    });
  });
  return result;
}

function structuralLocationKey(blockIndex: number, row: number, col: number): string {
  return `${blockIndex}:${row}:${col}`;
}

function structuralCandidateKey(blockIndex: number, row: number, normalizedLabel: string): string {
  return `${blockIndex}:${row}:${normalizedLabel}`;
}

/** 같은 행의 앞 라벨이 뒤 라벨을 포함하면 뒤 셀은 값 placeholder를 필드로 재인식한 경우가 많다. */
function suppressValueCellDuplicates(fields: RoundtripFieldCandidate[]): void {
  for (const candidate of fields) {
    const owner = fields.find((other) =>
      other !== candidate
      && other.location.blockIndex === candidate.location.blockIndex
      && other.location.row === candidate.location.row
      && other.location.col < candidate.location.col
      && (
        (
          other.normalizedLabel.length > candidate.normalizedLabel.length
          && other.normalizedLabel.endsWith(candidate.normalizedLabel)
        )
        || normalizeRoundtripLabel(other.originalValue) === candidate.normalizedLabel
      ));
    if (!owner) continue;
    candidate.recommendedInput = false;
    candidate.inputLikelihood = Math.min(candidate.inputLikelihood, 0.15);
    candidate.inputSignals.push(`앞 라벨 “${owner.label}”의 값 placeholder 가능성`);
  }
}

const POSITIVE_INPUT_LABEL = /(회사명|기업명|업체명|단체명|상호|법인명|기관명|대표자|성명|이름|신청인|담당자|책임자|사업자|법인번호|주민등록|연락처|전화|휴대|이메일|email|전자우편|주소|소재지|과제명|사업명|아이템명|제품명|서비스명|주생산품|업태|업종|종목|설립|개업|직위|부서|홈페이지|지원금|사업비|예산|금액|계좌|은행|예금주|상담|매출|고용|인원|자본금|기간|일자|날짜|년도|연도)/i;
const CONTENT_INPUT_LABEL = /((회사|기업|업체|단체|기관|제품|서비스|기술)소개|자기소개|개요|현황|계획|목표|필요성|전략|기대효과|시장|기술|실적|역량|일정|자금|추진|문제|해결|활용|성과|동기|신청사유|운영계획|요약|주요내용|세부내용|주고객|이용대상)/i;
const NON_INPUT_LABEL = /^(연번|순번|번호|구분|항목|서류명|제출서류|제출형식|형식|비고|배점|평가항목|확인|단위|천원|원|적용법률|법률)$/i;

/**
 * HWP 신청서는 빈 장문 셀에 파란 안내문을 미리 넣는 경우가 많다. KorDoc의 `empty=false`를
 * 그대로 믿으면 자기소개·창업동기 같은 실제 작성 칸이 필드맵에서 사라진다. 라벨이 서술형이고
 * 모든 줄이 명시적인 작성 안내 마커로 시작할 때만 기존 사용자 값이 아닌 placeholder로 본다.
 */
export function isNarrativeInstructionPlaceholder(label: string, value: string): boolean {
  const normalizedLabel = normalizeRoundtripLabel(label);
  if (!CONTENT_INPUT_LABEL.test(normalizedLabel)) return false;
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.some((line) => !/^(?:※|[·ㆍ•*-]\s+)/u.test(line))) return false;
  return /(작성|기술|기재|제시|설명|나타나도록|포함|계획|경력|전문성|동기|각오|열정|의지)/u.test(value);
}

export function assessRoundtripInputField(input: {
  label: string;
  type: RoundtripFieldType;
  row: number;
  required?: boolean;
}): { recommended: boolean; likelihood: number; signals: string[] } {
  const normalized = normalizeRoundtripLabel(input.label);
  const signals: string[] = [];
  let score = 0;
  const hasMetadataLabel = POSITIVE_INPUT_LABEL.test(normalized);
  if (hasMetadataLabel) {
    score += 4;
    signals.push("업체·담당자·과제 메타데이터 라벨");
  } else if (CONTENT_INPUT_LABEL.test(normalized)) {
    score += 3;
    signals.push("사업계획 서술 라벨");
  }
  if (input.type !== "text") {
    score += 2;
    signals.push(`${input.type} 형식 추론`);
  }
  if (input.required) {
    score += 4;
    signals.push("필수 표시가 있는 양식 셀");
  }
  if (normalized.length >= 2 && normalized.length <= 24) score += 1;
  if (NON_INPUT_LABEL.test(normalized)) {
    score -= 7;
    signals.push("표 머리글·단위 가능성이 높은 라벨");
  }
  if (/(작성목차|목차)$/.test(normalized)) {
    score -= 7;
    signals.push("목차 제목 가능성");
  }
  if (/^\d{4}년월일$/.test(normalized)) {
    score -= 7;
    signals.push("서명란의 고정 날짜 문구 가능성");
  }
  if (normalized.length > 32) {
    score -= 3;
    signals.push("제목·설명문 가능성이 높은 긴 라벨");
  }
  if (input.row === 0 && normalized.length > 16 && !hasMetadataLabel) {
    score -= 5;
    signals.push("표 첫 행의 긴 제목 가능성");
  }
  if (input.row === 0 && score <= 1) {
    score -= 2;
    signals.push("표 첫 행의 머리글 가능성");
  }
  return {
    recommended: score >= 2,
    likelihood: clamp(0.5 + score * 0.09, 0.05, 0.98),
    signals,
  };
}

export function inferRoundtripInputKind(
  label: string,
  type: RoundtripFieldType,
): RoundtripFieldInputKind {
  const normalized = normalizeRoundtripLabel(label);
  if (CONTENT_INPUT_LABEL.test(normalized)) {
    return "textarea";
  }
  if (type === "amount" || /(매출|금액|예산|사업비|지원금|자본금|연구개발비|종업원수|직원수|인원)/.test(normalized)) {
    return "number";
  }
  return "text";
}

export function generateRoundtripSampleValue(field: Pick<FormFieldSchema, "label" | "type">): {
  value: string;
  reason: string;
} {
  const label = normalizeRoundtripLabel(field.label);
  const match = (pattern: RegExp) => pattern.test(label);

  if (match(/(회사명|기업명|업체명|상호|법인명|사업자명|기관명|주관기관명)/)) return sample("주식회사 창업노트랩", "기업·기관명 라벨 매핑");
  if (match(/(대표자|성명|이름|신청인|담당자명)/)) return sample("김창업", "사람 이름 라벨 매핑");
  if (match(/(사업자등록번호|사업자번호)/)) return sample("123-45-67890", "사업자등록번호 형식 샘플");
  if (match(/(법인등록번호)/)) return sample("110111-1234567", "법인등록번호 형식 샘플");
  if (match(/(휴대폰|휴대전화|전화번호|연락처|전화)/) || field.type === "phone") return sample("010-1234-5678", "전화번호 형식 샘플");
  if (match(/(이메일|전자우편|메일)/) || field.type === "email") return sample("lab@example.com", "이메일 형식 샘플");
  if (match(/(홈페이지|웹사이트|website|url)/)) return sample("https://changupnote.com", "홈페이지 형식 샘플");
  if (match(/(주소|소재지|사업장)/)) return sample("서울특별시 중구 세종대로 110", "주소 라벨 매핑");
  if (match(/(과제명|사업명|프로젝트명|아이템명)/)) return sample("AI 기반 공모 지원 자동화 실증", "사업명 라벨 매핑");
  if (match(/(기술분야|사업분야|지원분야)/)) return sample("인공지능·데이터", "분야 라벨 매핑");
  if (match(/(산출물|결과물)/)) return sample("왕복 검증 결과보고서 1부", "산출물 라벨 매핑");
  if (match(/(지원금|사업비|예산|금액)/) || field.type === "amount") return sample("50,000,000원", "금액 형식 샘플");
  if (match(/(기간|협약기간|수행기간)/)) return sample("2026.08.01 ~ 2026.12.31", "기간 형식 샘플");
  if (match(/(설립일|개업일|작성일|신청일|일자|날짜)/) || field.type === "date") return sample("2026-07-20", "날짜 형식 샘플");
  if (match(/(업력|설립년도|연도|년도)/)) return sample("2026", "연도 형식 샘플");
  if (match(/(인원|종업원|직원수|고용)/)) return sample("5명", "인원 형식 샘플");
  if (match(/(매출|연구개발비|자본금)/)) return sample("100000", "숫자 금액 샘플");
  if (field.type === "checkbox") return sample("☑", "체크박스 선택 샘플");
  if (field.type === "idnum") return sample("900101-1234567", "식별번호 형식 샘플");
  return sample("공고 첨부 양식 왕복 저장을 검증하는 샘플 입력입니다.", "일반 텍스트 샘플");
}

function sample(value: string, reason: string): { value: string; reason: string } {
  return { value, reason };
}

/**
 * 인스턴스별 UI 값을 Kordoc의 label -> scalar|array 계약으로 변환한다.
 * 반복 라벨은 기존 값까지 포함한 배열을 만들어 특정 occurrence만 바꿔도 순서가 밀리지 않는다.
 */
export function buildRoundtripFillValues(
  fields: RoundtripFieldCandidate[],
  submitted: Record<string, string>,
): {
  values: Record<string, string | string[]>;
  requested: Array<{ field: RoundtripFieldCandidate; value: string }>;
} {
  const requested = fields.flatMap((field) => {
    const value = submitted[field.fieldInstanceId]?.trim();
    if (!value || value === field.originalValue.trim()) return [];
    return [{ field, value }];
  });
  const requestedIds = new Set(requested.map((item) => item.field.fieldInstanceId));
  const grouped = new Map<string, RoundtripFieldCandidate[]>();
  for (const field of fields) {
    const bucket = grouped.get(field.normalizedLabel) ?? [];
    bucket.push(field);
    grouped.set(field.normalizedLabel, bucket);
  }

  const values: Record<string, string | string[]> = {};
  for (const group of grouped.values()) {
    if (!group.some((field) => requestedIds.has(field.fieldInstanceId))) continue;
    const nextValues = group.map((field) => submitted[field.fieldInstanceId]?.trim() || field.originalValue);
    values[group[0]!.label] = group.length === 1 ? nextValues[0]! : nextValues;
  }
  return { values, requested };
}

export function likelyApplicationRole(role: RoundtripDocumentRole): boolean {
  return role === "application_form" || role === "business_plan" || role === "mixed_form";
}

export function hasLikelyApplicationFilename(filename: string): boolean {
  return APPLICATION_FILENAME.test(filename) || PLAN_FILENAME.test(filename);
}

export function declaredRoundtripFormat(filename: string): "hwp" | "hwpx" | null {
  const lowered = filename.toLowerCase();
  if (lowered.endsWith(".hwpx")) return "hwpx";
  if (lowered.endsWith(".hwp")) return "hwp";
  return null;
}
