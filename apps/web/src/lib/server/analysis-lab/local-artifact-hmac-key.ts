import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME = "ANALYSIS_LAB_ARTIFACT_HMAC_KEY";
const MIN_SECRET_LENGTH = 32;

export interface LocalArtifactHmacKeyResult {
  status: "created" | "existing";
  envPath: string;
}

/**
 * 로컬 release shadow 전용 키를 gitignored env 파일에 한 번만 만든다.
 * 키 값은 호출자에게 반환하지 않아 로그나 셸 출력으로 새는 경로를 만들지 않는다.
 */
export async function ensureLocalArtifactHmacKey(
  envPath: string,
): Promise<LocalArtifactHmacKeyResult> {
  const existingBody = await readEnvFileIfPresent(envPath);
  const existingValues = readEnvValues(existingBody, ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME);

  if (existingValues.length > 1) {
    throw new Error(`${ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME}가 로컬 env에 중복 정의되어 있습니다.`);
  }
  const existing = existingValues[0];
  if (existing !== undefined) {
    if (existing.length < MIN_SECRET_LENGTH) {
      throw new Error(`${ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME}는 32자 이상이어야 합니다.`);
    }
    await chmod(envPath, 0o600);
    return { status: "existing", envPath };
  }

  await mkdir(dirname(envPath), { recursive: true });
  const separator = existingBody.length === 0 || existingBody.endsWith("\n") ? "" : "\n";
  const secret = randomBytes(32).toString("hex");
  await appendFile(
    envPath,
    `${separator}${ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME}=${secret}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(envPath, 0o600);
  return { status: "created", envPath };
}

async function readEnvFileIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function readEnvValues(body: string, key: string): string[] {
  const values: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    if (rawKey?.trim() !== key) continue;
    let value = rest.join("=").trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.push(value);
  }
  return values;
}
