const POPBILL_ALERT_TIMEOUT_MS = 2_000;

export interface PopbillFailureAlertInput {
  surface: "teaser" | "company_enrichment";
  bizNo?: string | null;
  error: unknown;
  at?: Date;
}

export async function notifyPopbillFailure(input: PopbillFailureAlertInput): Promise<void> {
  const webhookUrl = readAdminSlackWebhookUrl();
  if (!webhookUrl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POPBILL_ALERT_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: formatPopbillFailureMessage(input),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`Admin Slack alert failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.warn(`Admin Slack alert failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function readAdminSlackWebhookUrl(): string | null {
  const value = process.env.POPBILL_ALERT_SLACK_WEBHOOK_URL ?? process.env.CUNOTE_ADMIN_SLACK_WEBHOOK_URL;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatPopbillFailureMessage(input: PopbillFailureAlertInput): string {
  const at = input.at ?? new Date();
  const lines = [
    "[창업노트] Popbill 사업자 정보 조회 실패",
    `- 경로: ${surfaceLabel(input.surface)}`,
    `- 사업자번호: ${maskBizNo(input.bizNo) ?? "미확인"}`,
    `- 오류: ${errorMessage(input.error)}`,
    `- 환경: ${process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown"}`,
    `- 시각: ${at.toISOString()}`,
    "- 확인: 팝빌 잔여포인트, 연동 키, IP 제한, 테스트/운영 모드를 확인해주세요.",
  ];
  return lines.join("\n");
}

function surfaceLabel(value: PopbillFailureAlertInput["surface"]): string {
  if (value === "company_enrichment") return "회사정보 보강";
  return "랜딩 티저";
}

function maskBizNo(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "").slice(0, 10);
  if (!digits || digits.length !== 10) return null;
  return `${digits.slice(0, 3)}-**-${digits.slice(5, 7)}***`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "unknown error";
}
