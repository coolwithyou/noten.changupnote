/**
 * 포트원 브라우저 SDK 로더 (설계 10.2).
 *
 * @portone/browser-sdk 를 npm 의존성으로 번들하지 않고, 공식 ESM CDN 에서 동적 로드한다
 * (결제 페이지에 진입할 때만 로드 — 초기 번들 영향 0). 실 결제는 채널 키·시크릿이 있어야
 * 동작하므로 개발/미설정 환경에서는 requestPayment 가 실패한다(정상).
 */

const PORTONE_SDK_URL = "https://cdn.portone.io/v2/browser-sdk.esm.js";

export interface RequestPaymentInput {
  storeId: string;
  channelKey: string;
  paymentId: string;
  orderName: string;
  totalAmount: number;
  redirectUrl: string;
}

export interface PortonePaymentResponse {
  code?: string; // 실패 코드(있으면 실패).
  message?: string;
  paymentId?: string;
  txId?: string;
}

interface PortoneBrowserSdk {
  requestPayment(input: Record<string, unknown>): Promise<PortonePaymentResponse | undefined>;
}

let sdkPromise: Promise<PortoneBrowserSdk> | null = null;

async function loadSdk(): Promise<PortoneBrowserSdk> {
  if (!sdkPromise) {
    sdkPromise = import(/* webpackIgnore: true */ PORTONE_SDK_URL).then(
      (mod) => (mod.default ?? mod) as PortoneBrowserSdk,
    );
  }
  return sdkPromise;
}

/**
 * 단건결제 요청. redirectUrl 필수(모바일 리다이렉트 대비 — 7.2).
 * 반환 response 에 code 가 있으면 실패, paymentId 만 있으면(또는 undefined) 성공/리다이렉트.
 */
export async function requestPayment(input: RequestPaymentInput): Promise<PortonePaymentResponse | undefined> {
  const PortOne = await loadSdk();
  return PortOne.requestPayment({
    storeId: input.storeId,
    channelKey: input.channelKey,
    paymentId: input.paymentId,
    orderName: input.orderName,
    totalAmount: input.totalAmount,
    currency: "CURRENCY_KRW", // 브라우저 SDK 는 CURRENCY_ 접두.
    payMethod: "CARD",
    redirectUrl: input.redirectUrl,
  });
}
