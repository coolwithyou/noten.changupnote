import { createRequire } from "node:module";
import type {
  PopbillBizCheckInfo,
  PopbillCredentials,
  PopbillEnvConfig,
} from "./types.js";

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
  };
}

export async function checkPopbillBizInfo(options: {
  credentials: PopbillCredentials;
  checkCorpNum: string;
}): Promise<PopbillBizCheckInfo> {
  const popbill = loadPopbill();
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

export function readPopbillEnvConfig(env: NodeJS.ProcessEnv = process.env): PopbillEnvConfig {
  const secretKey = readEnv(env, "POPBILL_SECRET_KEY", "POPBILL_API_KEY");
  const linkId = readEnv(env, "POPBILL_LINK_ID");
  const corpNum = readEnv(env, "POPBILL_CORP_NUM");
  const checkCorpNum = readEnv(env, "POPBILL_CHECK_CORP_NUM", "POPBILL_DEMO_CHECK_CORP_NUM");

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
    isTest: readBoolEnv(env, "POPBILL_IS_TEST", true),
    ipRestrictOnOff: readBoolEnv(env, "POPBILL_IP_RESTRICT_ON_OFF", true),
    useStaticIp: readBoolEnv(env, "POPBILL_USE_STATIC_IP", false),
    useLocalTimeYn: readBoolEnv(env, "POPBILL_USE_LOCAL_TIME_YN", true),
  };

  const userId = readOptionalEnv(env, "POPBILL_USER_ID");
  if (userId) credentials.userId = userId;

  return {
    credentials,
    checkCorpNum: sanitizeCorpNum(checkCorpNum!),
  };
}

export function sanitizeCorpNum(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{10}$/.test(digits)) {
    throw new Error("사업자번호는 숫자 10자리여야 합니다.");
  }
  return digits;
}

export function maskCorpNum(value: string): string {
  const digits = sanitizeCorpNum(value);
  return `${digits.slice(0, 3)}-**-${digits.slice(5, 7)}***`;
}

function loadPopbill(): PopbillModule {
  const require = createRequire(import.meta.url);
  return require("popbill") as PopbillModule;
}

function readEnv(env: NodeJS.ProcessEnv, name: string, alias?: string): string | null {
  return readOptionalEnv(env, name) ?? (alias ? readOptionalEnv(env, alias) : null);
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
