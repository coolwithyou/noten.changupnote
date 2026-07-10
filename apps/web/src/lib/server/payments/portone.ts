/**
 * 포트원 V2 클라이언트 모듈 (설계 7.5).
 *
 * ★ 규범: api.portone.io 를 직접 호출하는 코드는 이 파일에만 존재한다.
 *   다른 곳에서 결제 API 를 직접 부르지 않는다(감사·재시도·타임아웃을 한 곳으로 집중).
 *
 * - 모든 호출: 10s 타임아웃. GET(getPayment)만 1회 재시도. 쓰기(cancel/billing-key/schedule)는 재시도 없음.
 * - 멱등: 쓰기 호출에 Idempotency-Key 헤더(멱등 규약 키 재사용, 4.3).
 * - 인증: Authorization: `PortOne {API_SECRET}` (서버 시크릿).
 * - 키 미설정: PortoneNotConfiguredError(503 payment_unavailable). 나머지 앱 동작에는 영향 없다.
 *
 * 테스트를 위해 fetch·시각을 주입 가능한 구조로 만들고(createPortoneClient(deps)),
 * 통합 테스트는 스텁 클라이언트를 주입한다(포트원 실호출 금지 — 키 없음).
 */

const PORTONE_API_BASE = "https://api.portone.io";
const DEFAULT_TIMEOUT_MS = 10_000;

/** 포트원 결제 상태(서버 API — 접두 없는 원문). 7.2 상태 분기에서 사용. */
export type PortonePaymentStatus =
  | "READY"
  | "PENDING"
  | "VIRTUAL_ACCOUNT_ISSUED"
  | "PAID"
  | "FAILED"
  | "CANCELLED"
  | "PARTIAL_CANCELLED";

/** GET /payments/{id} 응답 중 우리가 신뢰·소비하는 필드(화이트리스트). */
export interface PortonePayment {
  id: string;
  status: PortonePaymentStatus;
  /** 결제 총액. 서버 API 는 amount.total. */
  amount: { total: number; paid: number | null; cancelled: number | null } | null;
  currency: string | null; // 서버 API 는 접두 없는 "KRW"
  /** 결제수단 타입(카드 등). */
  payMethod: string | null;
  paidAt: string | null;
  /** 취소 이력(부분취소 포함). */
  cancellations: PortoneCancellation[];
  /** 실패 사유. */
  failureReason: string | null;
  /** PG 거래 id 보관용(주문 portoneTxId). */
  transactionId: string | null;
}

export interface PortoneCancellation {
  id: string;
  status: string; // SUCCEEDED | REQUESTED | FAILED
  totalAmount: number | null;
  reason: string | null;
}

export interface CancelPaymentResult {
  cancellation: PortoneCancellation;
}

/** 키 미설정 — 결제 경로만 503 으로 실패하고 나머지 앱에는 영향 없다. */
export class PortoneNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = "payment_unavailable";
  constructor(message = "결제 서비스가 설정되지 않았습니다.") {
    super(message);
    this.name = "PortoneNotConfiguredError";
  }
}

/** 포트원 API 오류(비정상 응답). code 로 상위에서 매핑. */
export class PortoneApiError extends Error {
  readonly status = 502;
  readonly code = "payment_gateway_error";
  readonly httpStatus: number;
  readonly body: string;
  constructor(httpStatus: number, body: string) {
    super(`포트원 API 오류 (HTTP ${httpStatus})`);
    this.name = "PortoneApiError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

/** 예약결제 상태(GET /payment-schedules/{id}). 8.3 갱신 안전망 능동 조회에서 사용. */
export type PortoneScheduleStatus =
  | "SCHEDULED"
  | "STARTED"
  | "SUCCEEDED"
  | "FAILED"
  | "REVOKED"
  | "PENDING";

export interface PortoneClient {
  /** GET /payments/{id} — 진실의 원천(7.2·7.3). 1회 재시도. */
  getPayment(paymentId: string): Promise<PortonePayment>;
  /**
   * GET /payment-schedules/{id} — 예약결제 상태 능동 조회(8.3 갱신 안전망).
   * 상태를 화이트리스트 정규화한 `{ id, status }` 반환. 404(없는 예약)면 null.
   */
  getPaymentSchedule(scheduleId: string): Promise<{ id: string; status: string } | null>;
  /** POST /payments/{id}/cancel — 부분취소 지원. Idempotency-Key 필수. */
  cancelPayment(input: {
    paymentId: string;
    amount?: number; // 부분취소. 미지정이면 전액.
    reason: string;
    idempotencyKey: string;
  }): Promise<CancelPaymentResult>;
  /** POST /payments/{id}/billing-key — 빌링키 즉시결제(P4 구독). */
  payWithBillingKey(input: {
    paymentId: string;
    billingKey: string;
    orderName: string;
    amount: number;
    customerId: string;
    idempotencyKey: string;
  }): Promise<PortonePayment>;
  /** POST /payments/{id}/schedule — 예약결제(P4). */
  schedulePayment(input: {
    paymentId: string;
    billingKey: string;
    orderName: string;
    amount: number;
    customerId: string;
    timeToPay: string; // ISO
    idempotencyKey: string;
  }): Promise<{ scheduleId: string }>;
  /** DELETE /payment-schedules — 미소진 예약 취소(P4 구독 전이 첫 단계). */
  cancelSchedules(input: { billingKey?: string; scheduleIds?: string[] }): Promise<{ revokedScheduleIds: string[] }>;
  /** DELETE /billing-keys/{key} — 빌링키 삭제(P4 키 교체). */
  deleteBillingKey(input: { billingKey: string; idempotencyKey: string }): Promise<void>;
  /** 설정 여부(라우트가 조기 503 판정에 사용). */
  isConfigured(): boolean;
}

export interface PortoneClientDeps {
  storeId?: string;
  apiSecret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 실 클라이언트(직접 fetch 래핑). */
export function createPortoneClient(deps: PortoneClientDeps = {}): PortoneClient {
  const storeId = deps.storeId ?? process.env.PORTONE_STORE_ID?.trim();
  const apiSecret = deps.apiSecret ?? process.env.PORTONE_API_SECRET?.trim();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function ensureConfigured(): { storeId: string; apiSecret: string } {
    if (!storeId || !apiSecret) {
      throw new PortoneNotConfiguredError();
    }
    return { storeId, apiSecret };
  }

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { body?: Record<string, unknown>; idempotencyKey?: string; query?: Record<string, string> } = {},
  ): Promise<unknown> {
    const { apiSecret: secret } = ensureConfigured();
    const url = new URL(`${PORTONE_API_BASE}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      Authorization: `PortOne ${secret}`,
    };
    if (opts.body) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (opts.body) init.body = JSON.stringify(opts.body);
      const res = await fetchImpl(url.toString(), init);
      const text = await res.text();
      if (!res.ok) {
        throw new PortoneApiError(res.status, text);
      }
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET 전용 1회 재시도(네트워크·타임아웃·5xx). 4xx 는 재시도하지 않는다. */
  async function callGetWithRetry(path: string): Promise<unknown> {
    try {
      return await call("GET", path, {});
    } catch (error) {
      if (error instanceof PortoneNotConfiguredError) throw error;
      const isRetryable =
        error instanceof PortoneApiError ? error.httpStatus >= 500 : true; // 네트워크/abort 는 재시도.
      if (!isRetryable) throw error;
      return call("GET", path, {});
    }
  }

  return {
    isConfigured: () => Boolean(storeId && apiSecret),

    async getPayment(paymentId) {
      const raw = (await callGetWithRetry(`/payments/${encodeURIComponent(paymentId)}`)) as Record<string, unknown>;
      return normalizePayment(paymentId, raw);
    },

    async getPaymentSchedule(scheduleId) {
      try {
        const raw = (await callGetWithRetry(
          `/payment-schedules/${encodeURIComponent(scheduleId)}`,
        )) as Record<string, unknown>;
        const s = ((raw.schedule ?? raw) as Record<string, unknown>) ?? {};
        return { id: String(s.id ?? scheduleId), status: String(s.status ?? "") };
      } catch (error) {
        // 없는 예약(404)은 null — 조회 실패로 오판하지 않는다(cron 이 미실행 분기로 처리).
        if (error instanceof PortoneApiError && error.httpStatus === 404) return null;
        throw error;
      }
    },

    async cancelPayment(input) {
      ensureConfigured();
      const body: Record<string, unknown> = { storeId, reason: input.reason };
      if (typeof input.amount === "number") body.amount = input.amount;
      const raw = (await call("POST", `/payments/${encodeURIComponent(input.paymentId)}/cancel`, {
        body,
        idempotencyKey: input.idempotencyKey,
      })) as Record<string, unknown>;
      const c = (raw.cancellation ?? raw) as Record<string, unknown>;
      return {
        cancellation: {
          id: String(c.id ?? ""),
          status: String(c.status ?? "REQUESTED"),
          totalAmount: typeof c.totalAmount === "number" ? c.totalAmount : null,
          reason: (c.reason as string | null) ?? input.reason,
        },
      };
    },

    async payWithBillingKey(input) {
      const raw = (await call("POST", `/payments/${encodeURIComponent(input.paymentId)}/billing-key`, {
        body: {
          billingKey: input.billingKey,
          orderName: input.orderName,
          amount: { total: input.amount },
          currency: "KRW",
          customer: { id: input.customerId },
        },
        idempotencyKey: input.idempotencyKey,
      })) as Record<string, unknown>;
      return normalizePayment(input.paymentId, raw);
    },

    async schedulePayment(input) {
      const raw = (await call("POST", `/payments/${encodeURIComponent(input.paymentId)}/schedule`, {
        body: {
          payment: {
            billingKey: input.billingKey,
            orderName: input.orderName,
            amount: { total: input.amount },
            currency: "KRW",
            customer: { id: input.customerId },
          },
          timeToPay: input.timeToPay,
        },
        idempotencyKey: input.idempotencyKey,
      })) as Record<string, unknown>;
      const schedule = (raw.schedule ?? raw) as Record<string, unknown>;
      return { scheduleId: String(schedule.id ?? "") };
    },

    async cancelSchedules(input) {
      const body: Record<string, unknown> = { storeId };
      if (input.billingKey) body.billingKey = input.billingKey;
      if (input.scheduleIds) body.scheduleIds = input.scheduleIds;
      const raw = (await call("DELETE", `/payment-schedules`, { body })) as Record<string, unknown>;
      const revoked = (raw.revokedScheduleIds ?? []) as string[];
      return { revokedScheduleIds: Array.isArray(revoked) ? revoked.map(String) : [] };
    },

    async deleteBillingKey(input) {
      await call("DELETE", `/billing-keys/${encodeURIComponent(input.billingKey)}`, {
        body: { storeId, reason: "billing key rotation" },
        idempotencyKey: input.idempotencyKey,
      });
    },
  };
}

/** 포트원 응답(느슨한 형태)을 우리 화이트리스트 스키마로 정규화. */
function normalizePayment(paymentId: string, raw: Record<string, unknown>): PortonePayment {
  const p = ((raw.payment ?? raw) as Record<string, unknown>) ?? {};
  const amount = p.amount as Record<string, unknown> | undefined;
  const method = p.method as Record<string, unknown> | undefined;
  const failure = p.failure as Record<string, unknown> | undefined;
  const cancellations: PortoneCancellation[] = Array.isArray(p.cancellations)
    ? (p.cancellations as Array<Record<string, unknown>>).map((c) => ({
        id: String(c.id ?? ""),
        status: String(c.status ?? ""),
        totalAmount: typeof c.totalAmount === "number" ? c.totalAmount : null,
        reason: (c.reason as string | null) ?? null,
      }))
    : [];
  return {
    id: String(p.id ?? paymentId),
    status: String(p.status ?? "READY") as PortonePaymentStatus,
    amount: amount
      ? {
          total: Number(amount.total ?? 0),
          paid: typeof amount.paid === "number" ? amount.paid : null,
          cancelled: typeof amount.cancelled === "number" ? amount.cancelled : null,
        }
      : null,
    currency: (p.currency as string | null) ?? null,
    payMethod: (p.payMethod as string | null) ?? (method?.type as string | undefined) ?? null,
    paidAt: (p.paidAt as string | null) ?? null,
    cancellations,
    failureReason: failure ? ((failure.reason as string | null) ?? null) : null,
    transactionId: (p.transactionId as string | null) ?? (p.pgTxId as string | null) ?? null,
  };
}

// ── 싱글턴 접근자 ───────────────────────────────────────────────────────────
let cached: PortoneClient | null = null;
export function getPortoneClient(): PortoneClient {
  if (!cached) cached = createPortoneClient();
  return cached;
}
/** 테스트 전용: 스텁 클라이언트 주입. */
export function __setPortoneClientForTest(client: PortoneClient | null): void {
  cached = client;
}
