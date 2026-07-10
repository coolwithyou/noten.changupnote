/**
 * 포트원 V2 웹훅 서명 검증 (설계 7.3).
 *
 * 포트원 V2 는 표준 Webhooks(svix 호환) 스펙을 따른다:
 *   헤더: webhook-id, webhook-timestamp, webhook-signature ("v1,{base64sig} ..." 공백 구분 다중)
 *   서명 대상: `${webhookId}.${webhookTimestamp}.${rawBody}`
 *   비밀키: PORTONE_WEBHOOK_SECRET — "whsec_" 접두 뒤 base64.
 *   서명 = base64( HMAC-SHA256(secretBytes, signedContent) )
 *
 * ★ 규범(7.3): rawBody(JSON 파싱 전 원문)로 검증한다. 실패 → 401(본문 처리 없음).
 *   PII: payload 원문은 저장하지 않는다. 화이트리스트 발췌만 payloadDigest 로 저장(레드팀 M5).
 *
 * @portone/server-sdk 미설치이므로 표준 스펙을 직접 구현하되,
 * 테스트를 위해 시각·secret 을 주입 가능하게 만든다.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60; // 타임스탬프 허용 오차(재전송 공격 완화).

export class WebhookVerificationError extends Error {
  readonly status = 401;
  readonly code = "webhook_signature_invalid";
  constructor(message = "웹훅 서명 검증에 실패했습니다.") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface WebhookVerifyDeps {
  secret?: string;
  /**
   * 시크릿 회전 병행 검증 창(12.7 — 24h 무중단 전환)용 구(舊) 시크릿. 신규 시크릿 검증 실패 시
   * 이 값으로도 검증을 시도한다. 미지정이면 PORTONE_WEBHOOK_SECRET_PREVIOUS env 를 읽는다.
   * 회전 완료(24h 경과) 후에는 이 env 를 제거해 구 시크릿 검증 창을 닫는다.
   */
  previousSecret?: string;
  now?: () => Date;
}

/** 웹훅에서 우리가 소비하는 최소 필드(파싱 결과). */
export interface PortoneWebhookPayload {
  type: string; // 예: "Transaction.Paid"
  timestamp?: string;
  data?: {
    paymentId?: string;
    transactionId?: string;
    storeId?: string;
    billingKey?: string;
    cancellationId?: string;
  };
}

/**
 * 서명 검증 + JSON 파싱. 검증 실패·secret 미설정 시 WebhookVerificationError(401).
 * secret 미설정을 401 로 처리하는 이유: 검증 불가능한 웹훅을 처리하면 안 된다(7.3 — 서명 실패만 401).
 */
export function verifyPortoneWebhook(
  rawBody: string,
  headers: Headers,
  deps: WebhookVerifyDeps = {},
): PortoneWebhookPayload {
  const secretRaw = deps.secret ?? process.env.PORTONE_WEBHOOK_SECRET?.trim();
  if (!secretRaw) {
    throw new WebhookVerificationError("웹훅 시크릿이 설정되지 않았습니다.");
  }
  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const webhookSignature = headers.get("webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    throw new WebhookVerificationError("웹훅 헤더가 없습니다.");
  }

  // 타임스탬프 허용 오차 검사.
  const now = deps.now?.() ?? new Date();
  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > TOLERANCE_SECONDS) {
    throw new WebhookVerificationError("웹훅 타임스탬프가 허용 범위를 벗어났습니다.");
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;

  // webhook-signature 는 "v1,{sig} v1,{sig2}" 형태(공백 구분). 하나라도 일치하면 통과.
  const candidates = webhookSignature.split(" ").map((part) => {
    const comma = part.indexOf(",");
    return comma === -1 ? part : part.slice(comma + 1);
  });

  // 시크릿 회전 병행 검증(12.7): 신규 → 구 시크릿 순으로 시도. 하나라도 검증되면 통과.
  // 구 시크릿은 회전 창(24h) 동안만 설정되고, 창이 닫히면 env 를 제거한다.
  const previousSecretRaw = deps.previousSecret ?? process.env.PORTONE_WEBHOOK_SECRET_PREVIOUS?.trim();
  const secretsToTry = [secretRaw];
  if (previousSecretRaw && previousSecretRaw !== secretRaw) {
    secretsToTry.push(previousSecretRaw);
  }

  const ok = secretsToTry.some((secret) => {
    const expected = createHmac("sha256", secretKeyBytes(secret)).update(signedContent).digest("base64");
    return candidates.some((cand) => safeEqualBase64(cand, expected));
  });
  if (!ok) {
    throw new WebhookVerificationError();
  }

  let parsed: PortoneWebhookPayload;
  try {
    parsed = JSON.parse(rawBody) as PortoneWebhookPayload;
  } catch {
    throw new WebhookVerificationError("웹훅 본문이 JSON 이 아닙니다.");
  }
  return parsed;
}

function secretKeyBytes(secret: string): Buffer {
  // "whsec_" 접두가 있으면 뒤를 base64 로 디코드(svix 규약). 없으면 원문 utf8.
  if (secret.startsWith("whsec_")) {
    return Buffer.from(secret.slice("whsec_".length), "base64");
  }
  return Buffer.from(secret, "utf8");
}

function safeEqualBase64(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "base64");
  const bufB = Buffer.from(b, "base64");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
