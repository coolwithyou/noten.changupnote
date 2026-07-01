import type {
  PopbillBizCheckInfo,
  PopbillApiEndpoint,
  PopbillCredentials,
  PopbillEnvironment,
  PopbillEnvConfig,
} from "./types.js";
import { sanitizeCorpNum } from "./corp-num.js";
export { maskCorpNum, sanitizeCorpNum } from "./corp-num.js";

const POPBILL_DEFAULT_ENDPOINTS: Record<PopbillEnvironment, Omit<PopbillApiEndpoint, "environment">> = {
  test: {
    baseUrl: "https://popbill-test.linkhub.co.kr",
    serviceId: "POPBILL_TEST",
  },
  production: {
    baseUrl: "https://popbill.linkhub.co.kr",
    serviceId: "POPBILL",
  },
};

interface PopbillModule {
  config(options: {
    LinkID: string;
    SecretKey: string;
    IsTest: boolean;
    IPRestrictOnOff: boolean;
    UseStaticIP: boolean;
    UseLocalTimeYN: boolean;
  }): void;
  BizInfoCheckService(): {
    checkBizInfo(
      corpNum: string,
      checkCorpNum: string,
      userId: string,
      success: (result: unknown) => void,
      error: (error: unknown) => void,
    ): void;
    getBalance(
      corpNum: string,
      success: (remainPoint: number) => void,
      error: (error: unknown) => void,
    ): void;
    getPartnerBalance(
      corpNum: string,
      success: (remainPoint: number) => void,
      error: (error: unknown) => void,
    ): void;
  };
}

export interface PopbillBalances {
  /** 연동회원(CorpNum) 잔여포인트 */
  memberPoint: number;
  /** 파트너(LinkID) 잔여포인트 — 사업자등록정보 조회는 이 지갑에서 차감된다. */
  partnerPoint: number;
}

export async function checkPopbillBizInfo(options: {
  credentials: PopbillCredentials;
  checkCorpNum: string;
}): Promise<PopbillBizCheckInfo> {
  const popbill = await loadPopbill();
  popbill.config({
    LinkID: options.credentials.linkId,
    SecretKey: options.credentials.secretKey,
    IsTest: options.credentials.isTest,
    IPRestrictOnOff: options.credentials.ipRestrictOnOff,
    UseStaticIP: options.credentials.useStaticIp,
    UseLocalTimeYN: options.credentials.useLocalTimeYn,
  });

  const service = popbill.BizInfoCheckService();
  const result = await new Promise<unknown>((resolve, reject) => {
    service.checkBizInfo(
      options.credentials.corpNum,
      sanitizeCorpNum(options.checkCorpNum),
      options.credentials.userId ?? "",
      resolve,
      reject,
    );
  });
  return result as PopbillBizCheckInfo;
}

/**
 * 팝빌 잔여포인트를 조회한다. 포인트 조회는 무과금이라 헬스체크/부팅 로그에 안전하게 쓸 수 있다.
 */
export async function getPopbillBalances(credentials: PopbillCredentials): Promise<PopbillBalances> {
  const popbill = await loadPopbill();
  popbill.config({
    LinkID: credentials.linkId,
    SecretKey: credentials.secretKey,
    IsTest: credentials.isTest,
    IPRestrictOnOff: credentials.ipRestrictOnOff,
    UseStaticIP: credentials.useStaticIp,
    UseLocalTimeYN: credentials.useLocalTimeYn,
  });

  const service = popbill.BizInfoCheckService();
  const [memberPoint, partnerPoint] = await Promise.all([
    new Promise<number>((resolve, reject) => {
      service.getBalance(credentials.corpNum, resolve, reject);
    }),
    new Promise<number>((resolve, reject) => {
      service.getPartnerBalance(credentials.corpNum, resolve, reject);
    }),
  ]);

  return { memberPoint, partnerPoint };
}

export function readPopbillEnvConfig(env: NodeJS.ProcessEnv = process.env): PopbillEnvConfig {
  const secretKey = readEnv(env, "POPBILL_SECRET_KEY", "POPBILL_API_KEY");
  const linkId = readEnv(env, "POPBILL_LINK_ID");
  const corpNum = readEnv(env, "POPBILL_CORP_NUM");
  const checkCorpNum = readEnv(env, "POPBILL_CHECK_CORP_NUM", "POPBILL_DEMO_CHECK_CORP_NUM");
  const explicitEnvironment = readPopbillEnvironment(env);
  const isTest = readBoolEnv(
    env,
    "POPBILL_IS_TEST",
    explicitEnvironment ? explicitEnvironment === "test" : true,
  );
  const activeEnvironment = explicitEnvironment ?? (isTest ? "test" : "production");

  if (explicitEnvironment && isTest !== (explicitEnvironment === "test")) {
    throw new Error("POPBILL_ENVIRONMENT and POPBILL_IS_TEST point to different Popbill environments.");
  }

  const missing = [
    ["POPBILL_SECRET_KEY", secretKey],
    ["POPBILL_LINK_ID", linkId],
    ["POPBILL_CORP_NUM", corpNum],
    ["POPBILL_CHECK_CORP_NUM", checkCorpNum],
  ].flatMap(([name, value]) => value ? [] : [name]);

  if (missing.length > 0) {
    throw new Error(`Missing required Popbill env keys: ${missing.join(", ")}`);
  }

  const credentials: PopbillCredentials = {
    linkId: linkId!,
    secretKey: secretKey!,
    corpNum: sanitizeCorpNum(corpNum!),
    isTest,
    ipRestrictOnOff: readBoolEnv(env, "POPBILL_IP_RESTRICT_ON_OFF", true),
    useStaticIp: readBoolEnv(env, "POPBILL_USE_STATIC_IP", false),
    useLocalTimeYn: readBoolEnv(env, "POPBILL_USE_LOCAL_TIME_YN", true),
  };

  const userId = readOptionalEnv(env, "POPBILL_USER_ID");
  if (userId) credentials.userId = userId;

  return {
    credentials,
    checkCorpNum: sanitizeCorpNum(checkCorpNum!),
    endpoint: readPopbillApiEndpoint(env, activeEnvironment),
  };
}

async function loadPopbill(): Promise<PopbillModule> {
  const specifier = "popbill";
  const mod = await import(specifier);
  return ((mod as { default?: unknown }).default ?? mod) as PopbillModule;
}

function readEnv(env: NodeJS.ProcessEnv, name: string, alias?: string): string | null {
  return readOptionalEnv(env, name) ?? (alias ? readOptionalEnv(env, alias) : null);
}

function readPopbillApiEndpoint(env: NodeJS.ProcessEnv, environment: PopbillEnvironment): PopbillApiEndpoint {
  const prefix = environment === "test" ? "TEST" : "PRODUCTION";
  const defaults = POPBILL_DEFAULT_ENDPOINTS[environment];
  return {
    environment,
    baseUrl:
      readOptionalEnv(env, `POPBILL_${prefix}_BASE_URL`) ??
      readOptionalEnv(env, "POPBILL_BASE_URL") ??
      defaults.baseUrl,
    serviceId:
      readOptionalEnv(env, `POPBILL_${prefix}_SERVICE_ID`) ??
      readOptionalEnv(env, "POPBILL_SERVICE_ID") ??
      defaults.serviceId,
  };
}

function readPopbillEnvironment(env: NodeJS.ProcessEnv): PopbillEnvironment | null {
  const value =
    readOptionalEnv(env, "POPBILL_ENVIRONMENT")?.toLowerCase() ??
    readOptionalEnv(env, "POPBILL_ENV")?.toLowerCase();
  if (!value) return null;
  if (["test", "sandbox", "dev", "development"].includes(value)) return "test";
  if (["production", "prod", "live"].includes(value)) return "production";
  throw new Error(`Invalid POPBILL_ENVIRONMENT: ${value}`);
}

function readOptionalEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function readBoolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value);
}
