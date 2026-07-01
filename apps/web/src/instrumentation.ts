/**
 * Next.js 서버 부팅 시 1회 실행되는 훅.
 * `pnpm dev:web`(및 운영 서버) 로드 시 팝빌 운영 모드/잔여포인트를 로그로 남긴다.
 */
export async function register(): Promise<void> {
  // Node 런타임에서만 실행 (Edge에서는 popbill SDK/네트워크 사용 불가)
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await logPopbillRuntimeMode();
}

async function logPopbillRuntimeMode(): Promise<void> {
  const tag = "[Popbill]";

  // Keep this import non-static. Next also compiles instrumentation for Edge,
  // and a literal @cunote/core import pulls Node-only HWP exports into that bundle.
  const core = await importCoreForNode();
  let config: ReturnType<typeof core.readPopbillEnvConfig>;
  try {
    config = core.readPopbillEnvConfig();
  } catch (error) {
    console.warn(`${tag} 환경 설정을 읽지 못해 모드 점검을 건너뜁니다: ${messageOf(error)}`);
    return;
  }

  const { credentials, endpoint } = config;
  const isProduction = endpoint.environment === "production";
  const modeLabel = isProduction
    ? "⚠️  운영(production) · 실과금(건당 차감)"
    : "🧪  테스트베드(test) · 무과금";

  console.log(`${tag} 모드: ${modeLabel}`);
  console.log(
    `${tag} endpoint=${endpoint.baseUrl} · serviceId=${endpoint.serviceId} · ` +
      `LinkID=${credentials.linkId} · CorpNum=${core.maskCorpNum(credentials.corpNum)}`,
  );

  // 잔여포인트 조회(무과금)는 부팅을 막지 않도록 fire-and-forget + 타임아웃 처리.
  void (async () => {
    try {
      const balances = await withTimeout(core.getPopbillBalances(credentials), 5000);
      const partner = balances.partnerPoint.toLocaleString("ko-KR");
      const member = balances.memberPoint.toLocaleString("ko-KR");
      console.log(`${tag} 잔여포인트: 파트너=${partner}P · 연동회원=${member}P`);
      if (isProduction && balances.partnerPoint <= 0) {
        console.warn(
          `${tag} ⚠️  운영 파트너 포인트가 0입니다 — 사업자 조회가 실패합니다. ` +
            "링크허브 파트너 콘솔에서 운영 파트너 포인트를 충전하세요.",
        );
      }
    } catch (error) {
      console.warn(`${tag} 잔여포인트 조회 실패(부팅에는 영향 없음): ${messageOf(error)}`);
    }
  })();
}

async function importCoreForNode(): Promise<typeof import("@cunote/core/popbill/check-biz-info")> {
  const specifier = "@cunote/core/popbill/check-biz-info";
  return import(specifier);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${ms}ms 타임아웃`)), ms);
      timer.unref?.();
    }),
  ]);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
