import type { ApplyMethodChannel, AuthoringMode } from "@cunote/contracts";

// 지원서 작성 방식(authoring mode) 분류의 단일 원천.
// 공고를 "지원서를 어떻게 작성하는가" 기준으로 나눈다:
//   - file_form: HWP 등 서식 파일을 작성해 제출(업로드/이메일/방문 등) — cunote 서식 채움 대상
//   - web_form:  사이트 신청 페이지에서 직접 입력(구글폼, 시스템 폼 등)
//   - unknown:   판별 신호 부족
//
// 접수방법(f_apply_methods)만으로는 부족하다: online 접수라도 서식 파일을 첨부 업로드하는 형태가 많다.
// 그래서 첨부 파일명(서식성)·제출서류 텍스트·접수 채널·안내 텍스트를 종합해 판정한다.

export interface AuthoringModeInput {
  /** 첨부 파일명들. */
  attachmentFilenames: string[];
  /** 첨부 목록이 수집된 소스인지. 미수집이면 "첨부 없음"을 신호로 쓰면 안 됨(정보 부재 ≠ 서식 없음). */
  attachmentsKnown: boolean;
  /** classifyApplyMethods 결과(정규화된 접수 채널). */
  applyMethods: ApplyMethodChannel[];
  /** apply_method jsonb 의 텍스트 값들(안내문). */
  applyMethodTexts: string[];
  /** K-Startup detail 의 제출서류 텍스트. */
  submitDocumentsText?: string | null;
}

// ── 규칙 1: 서식성 첨부 존재 → file_form ──────────────────────────────
// 신청서/양식/사업계획서 등 작성 대상 키워드 + 문서 확장자(hwp/hwpx/doc/docx).
const FORM_KEYWORD_PATTERN =
  /신청서|지원서|신청양식|서식|양식|사업계획서|지원서류|계획서|신청\s*서식/;
const FORM_EXTENSION_PATTERN = /\.(hwp|hwpx|doc|docx)$/i;

// ── 규칙 2: 제출서류 텍스트가 "양식 작성/첨부 서식" 을 시사 → file_form ──
const SUBMIT_FORM_PATTERN =
  /양식.{0,20}작성|작성.{0,30}(업로드|제출)|첨부.{0,20}(양식|서식)|별첨.{0,20}(양식|서식)/;

// ── 규칙 3: 웹폼 명시(구글폼/설문/시스템 직접 입력) → web_form ──────────
const WEB_FORM_PATTERN =
  /구글\s*폼|google\s*form|설문|온라인\s*폼|폼\s*작성|시스템.{0,10}(직접\s*)?입력/i;

function hasFormAttachment(filenames: string[]): boolean {
  return filenames.some((raw) => {
    const name = raw.trim();
    if (!name) return false;
    return FORM_KEYWORD_PATTERN.test(name) && FORM_EXTENSION_PATTERN.test(name);
  });
}

/**
 * 파일명이 작성 대상 서식(신청서/양식/사업계획서 등)으로 보이는지.
 * 확장자는 검사하지 않는다 — 보관본(.hwpx)과 hwp2hwpx sibling 원본명(.hwp)을 같은 규칙으로 거르기 위함.
 */
export function isFormLikeFilename(filename: string): boolean {
  return FORM_KEYWORD_PATTERN.test(filename.trim());
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function classifyAuthoringMode(input: AuthoringModeInput): AuthoringMode {
  const submitText = hasText(input.submitDocumentsText) ? input.submitDocumentsText : "";
  const applyTexts = input.applyMethodTexts.filter(hasText);

  // 규칙 1: 서식성 첨부가 있으면 서식 파일 작성으로 확정(가장 강한 신호).
  if (hasFormAttachment(input.attachmentFilenames)) return "file_form";

  // 규칙 2: 제출서류 텍스트가 양식 작성/첨부 서식을 명시.
  if (submitText && SUBMIT_FORM_PATTERN.test(submitText)) return "file_form";

  // 규칙 3: 웹폼(구글폼/설문/시스템 직접 입력) 명시.
  if ([...applyTexts, submitText].some((text) => text && WEB_FORM_PATTERN.test(text))) {
    return "web_form";
  }

  // 규칙 4: online 채널이 전혀 없으면 웹폼일 수 없음(이메일/팩스/우편/방문뿐 → 서식 제출).
  if (input.applyMethods.length > 0 && !input.applyMethods.includes("online")) {
    return "file_form";
  }

  // 규칙 5: 첨부가 수집됐고 online 접수인데 서식 신호가 없으면 웹폼 직접 작성으로 본다.
  if (input.attachmentsKnown && input.applyMethods.includes("online")) {
    return "web_form";
  }

  // 규칙 6: 그 외 — 판별 신호 부족.
  return "unknown";
}
