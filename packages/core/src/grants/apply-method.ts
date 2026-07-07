import { APPLY_METHOD_CHANNELS, type ApplyMethodChannel } from "@cunote/contracts";

// 접수방법(apply method) 채널 분류의 단일 원천.
// grants.apply_method(jsonb)는 소스별 구조가 다르다:
//   - K-Startup: 구조화 키(online/email/fax/visit/postal/other) — 값은 안내 텍스트 또는 null
//   - BizInfo:  { text: 자유텍스트 } — "온라인 접수 (구글폼)", "이메일 접수 (xxx@yyy.kr)" 등
// 구조화 키는 truthy 값이면 채널 확정, other/text 자유 텍스트는 키워드로 분류한다.

// 구조화 키 = 그 자체가 채널을 뜻하는 키. presence(truthy)만으로 채널을 확정한다.
const STRUCTURED_KEYS = ["online", "email", "fax", "visit", "postal"] as const satisfies readonly ApplyMethodChannel[];
// 자유 텍스트 키 = 안내문에서 채널을 추론해야 하는 키(K-Startup other, BizInfo text).
const FREE_TEXT_KEYS = ["other", "text"] as const;

// 이메일 주소 표기(xxx@yyy.kr)만으로도 이메일 접수로 본다.
const EMAIL_ADDRESS_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/;

const ONLINE_PATTERN = /온라인|홈페이지|누리집|시스템|전산|앱|구글\s*폼|신청하기|웹사이트|사이트/;
const EMAIL_PATTERN = /이메일|전자우편|e-?mail/i;
const FAX_PATTERN = /팩스|fax/i;
const VISIT_PATTERN = /방문|내방|접수처|오프라인|현장/;
const POSTAL_PATTERN = /우편|등기/;

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// 자유 텍스트 한 건을 채널 집합으로 분류. 어떤 키워드에도 안 걸리는 비어있지 않은 텍스트는 other.
function classifyFreeText(raw: string): ApplyMethodChannel[] {
  const text = raw.trim();
  if (!text) return [];
  const channels = new Set<ApplyMethodChannel>();
  if (ONLINE_PATTERN.test(text)) channels.add("online");
  if (EMAIL_PATTERN.test(text) || EMAIL_ADDRESS_PATTERN.test(text)) channels.add("email");
  if (FAX_PATTERN.test(text)) channels.add("fax");
  if (VISIT_PATTERN.test(text)) channels.add("visit");
  // "전자우편"의 "우편" 오탐 방지 — 이메일 표기를 제거한 뒤 우편/등기를 검사한다.
  if (POSTAL_PATTERN.test(text.replace(/전자우편/g, ""))) channels.add("postal");
  if (channels.size === 0) channels.add("other");
  return [...channels];
}

export function classifyApplyMethods(
  applyMethod: Record<string, string | null> | null | undefined,
): ApplyMethodChannel[] {
  if (!applyMethod) return [];
  const channels = new Set<ApplyMethodChannel>();

  for (const key of STRUCTURED_KEYS) {
    if (hasText(applyMethod[key])) channels.add(key);
  }
  for (const key of FREE_TEXT_KEYS) {
    const value = applyMethod[key];
    if (hasText(value)) {
      for (const channel of classifyFreeText(value)) channels.add(channel);
    }
  }

  // 중복 제거 + APPLY_METHOD_CHANNELS 표준 순서로 정렬.
  return APPLY_METHOD_CHANNELS.filter((channel) => channels.has(channel));
}
