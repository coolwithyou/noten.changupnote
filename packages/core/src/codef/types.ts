/**
 * CODEF 코어 공용 타입 — 환경설정·토큰·응답 봉투.
 *
 * CODEF(홈택스 간편인증) 연동의 순수 코어 계층에서 공유하는 타입을 한곳에 모은다.
 * 네트워크 호출은 각 모듈에서 fetchImpl 주입으로 격리하고, 여기서는 데이터 형태만 정의한다.
 */

/** 연동 환경. demo=개발(development.codef.io) / production=운영(api.codef.io). */
export type CodefEnvironment = "demo" | "production";

/** readCodefEnvConfig 결과 — 클라이언트 자격증명 + 파생 URL. */
export interface CodefEnvConfig {
  /** OAuth clientId(CODEF_CLIENT_ID). */
  clientId: string;
  /** OAuth clientSecret(CODEF_CLIENT_SECRET). */
  clientSecret: string;
  /** RSA 공개키 Base64 DER(SPKI)(CODEF_PUBLIC_KEY) — 인증서 비번 등 암호화용. */
  publicKey: string;
  /** 해석된 환경(미지정/오타 시 demo 폴백). */
  environment: CodefEnvironment;
  /** 상품 API base URL(환경별 분기). */
  apiBaseUrl: string;
  /** 토큰 발급 URL(환경 무관 고정). */
  tokenUrl: string;
}

/** OAuth client_credentials 토큰(파싱 결과). */
export interface CodefToken {
  /** 액세스 토큰(Bearer). */
  accessToken: string;
  /** 토큰 타입(보통 "bearer"). */
  tokenType: string;
  /** 만료까지 남은 초(발급 시점 기준, CODEF ≈604799 = 7일). */
  expiresInSec: number;
  /** 파싱(발급) 시각 epoch ms — 만료 판정 기준. */
  obtainedAtMs: number;
}

/** CODEF 응답 봉투 result 오브젝트. */
export interface CodefResult {
  /** 결과 코드. 성공 "CF-00000", 추가인증 필요 "CF-03002". */
  code: string;
  /** 결과 메시지. */
  message: string;
  /** 거래 고유 ID(있으면). */
  transactionId?: string;
}

/** CODEF 응답 봉투 전체(`{result, data}`). */
export interface CodefResultEnvelope {
  result: CodefResult;
  data: unknown;
}
