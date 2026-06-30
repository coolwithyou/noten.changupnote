import { createHmac, timingSafeEqual } from "node:crypto";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { markdownDownloadResponse } from "@/lib/server/documents/downloadHeaders";

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_DAYS = 90;

export class ApplicationCalendarSubscriptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApplicationCalendarSubscriptionError";
  }
}

export interface ApplicationCalendarSubscription {
  filename: string;
  fallbackFilename: string;
  token: string;
  httpsUrl: string;
  webcalUrl: string;
  expiresAt: string;
  markdown: string;
}

interface CalendarTokenPayload {
  v: 1;
  companyId: string;
  userId: string;
  role: CompanyAccess["role"];
  iat: number;
  exp: number;
}

export function buildApplicationCalendarSubscription(input: {
  access: CompanyAccess;
  origin: string;
  issuedAt?: Date;
  ttlDays?: number;
}): ApplicationCalendarSubscription {
  const issuedAt = input.issuedAt ?? new Date();
  const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(issuedAt.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const payload: CalendarTokenPayload = {
    v: 1,
    companyId: input.access.companyId,
    userId: input.access.userId,
    role: input.access.role,
    iat: Math.floor(issuedAt.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const token = signCalendarSubscriptionPayload(payload);
  const httpsUrl = `${safeOrigin(input.origin)}/api/web/applications/calendar-feed/${encodeURIComponent(token)}`;
  const webcalUrl = toWebcalUrl(httpsUrl);
  const stamp = dateStamp(issuedAt);
  const subscription = {
    filename: `창업노트-신청캘린더-구독-${stamp}.md`,
    fallbackFilename: `cunote-application-calendar-subscription-${stamp}.md`,
    token,
    httpsUrl,
    webcalUrl,
    expiresAt: expiresAt.toISOString(),
    markdown: "",
  } satisfies Omit<ApplicationCalendarSubscription, "markdown"> & { markdown: string };
  return {
    ...subscription,
    markdown: renderApplicationCalendarSubscription(subscription, issuedAt),
  };
}

export function applicationCalendarSubscriptionDownloadResponse(
  subscription: ApplicationCalendarSubscription,
): Response {
  return markdownDownloadResponse({
    markdown: subscription.markdown,
    filename: subscription.filename,
    fallbackFilename: subscription.fallbackFilename,
  });
}

export function verifyApplicationCalendarSubscriptionToken(input: {
  token: string;
  now?: Date;
}): CompanyAccess {
  const token = input.token.trim();
  const [version, encodedPayload, signature] = token.split(".");
  if (version !== TOKEN_VERSION || !encodedPayload || !signature) {
    throw new ApplicationCalendarSubscriptionError(
      "invalid_calendar_subscription_token",
      "캘린더 구독 링크가 올바르지 않습니다.",
      401,
      "token",
    );
  }

  const expected = signCalendarSubscriptionBody(`${version}.${encodedPayload}`);
  if (!safeEqual(signature, expected)) {
    throw new ApplicationCalendarSubscriptionError(
      "invalid_calendar_subscription_token",
      "캘린더 구독 링크가 올바르지 않습니다.",
      401,
      "token",
    );
  }

  const payload = parsePayload(encodedPayload);
  const now = input.now ?? new Date();
  if (payload.exp <= Math.floor(now.getTime() / 1000)) {
    throw new ApplicationCalendarSubscriptionError(
      "expired_calendar_subscription_token",
      "캘린더 구독 링크가 만료되었습니다. 신청 관리 화면에서 새 구독 URL을 발급하세요.",
      410,
      "token",
    );
  }

  return {
    companyId: payload.companyId,
    userId: payload.userId,
    role: payload.role,
    mode: "token",
  };
}

function renderApplicationCalendarSubscription(
  subscription: Omit<ApplicationCalendarSubscription, "markdown">,
  generatedAt: Date,
): string {
  return [
    "# 창업노트 신청 캘린더 구독 URL",
    "",
    `- 생성: ${formatDateTime(generatedAt)}`,
    `- 만료: ${formatDateTime(new Date(subscription.expiresAt))}`,
    "- 범위: 현재 회사의 신청 파이프라인 마감일과 내부 리마인더",
    "",
    "## 구독 링크",
    "",
    `- Webcal: ${subscription.webcalUrl}`,
    `- HTTPS: ${subscription.httpsUrl}`,
    "",
    "## 사용 방법",
    "",
    "- Google Calendar, Apple Calendar, Outlook의 URL로 구독 기능에 Webcal 또는 HTTPS 링크를 붙여넣습니다.",
    "- 링크를 가진 사람은 이 회사의 신청 일정 feed를 읽을 수 있으므로 팀 내부에서만 공유합니다.",
    "- 담당자, 리마인더, 제출 상태를 바꾸면 캘린더 앱의 다음 동기화 때 feed에 반영됩니다.",
    "- 링크가 만료되면 신청 관리 화면에서 새 구독 URL을 내려받습니다.",
    "",
  ].join("\n");
}

function signCalendarSubscriptionPayload(payload: CalendarTokenPayload): string {
  const encoded = encodeBase64Url(JSON.stringify(payload));
  return `${TOKEN_VERSION}.${encoded}.${signCalendarSubscriptionBody(`${TOKEN_VERSION}.${encoded}`)}`;
}

function signCalendarSubscriptionBody(value: string): string {
  return createHmac("sha256", tokenSecret()).update(value).digest("base64url");
}

function parsePayload(encodedPayload: string): CalendarTokenPayload {
  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<CalendarTokenPayload>;
    if (
      decoded.v !== 1 ||
      typeof decoded.companyId !== "string" ||
      decoded.companyId.length === 0 ||
      typeof decoded.userId !== "string" ||
      decoded.userId.length === 0 ||
      !isCompanyRole(decoded.role) ||
      typeof decoded.iat !== "number" ||
      typeof decoded.exp !== "number" ||
      decoded.exp <= decoded.iat
    ) {
      throw new Error("invalid payload");
    }
    return decoded as CalendarTokenPayload;
  } catch {
    throw new ApplicationCalendarSubscriptionError(
      "invalid_calendar_subscription_token",
      "캘린더 구독 링크가 올바르지 않습니다.",
      401,
      "token",
    );
  }
}

function isCompanyRole(value: unknown): value is CompanyAccess["role"] {
  return value === "owner" || value === "admin" || value === "member" || value === "viewer";
}

function tokenSecret(): string {
  const secret = process.env.CUNOTE_CALENDAR_FEED_SECRET
    ?? process.env.JWT_SECRET
    ?? process.env.NEXTAUTH_SECRET
    ?? process.env.AUTH_SECRET;
  if (secret?.trim()) return secret;
  if (process.env.NODE_ENV !== "production") return "cunote-dev-calendar-feed-secret";
  throw new ApplicationCalendarSubscriptionError(
    "calendar_feed_secret_missing",
    "캘린더 구독 feed secret이 설정되지 않았습니다.",
    503,
  );
}

function safeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin;
  } catch {
    return "http://localhost:4010";
  }
}

function toWebcalUrl(httpsUrl: string): string {
  return httpsUrl.replace(/^https?:/i, "webcal:");
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(value);
}

function dateStamp(value: Date): string {
  return value.toISOString().slice(0, 10);
}
