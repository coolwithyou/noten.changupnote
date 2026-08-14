import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const IMMUTABLE_ARTIFACT_TEMP_FILE =
  /^\.immutable-artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

export function isImmutableArtifactTempFileName(name: string): boolean {
  return IMMUTABLE_ARTIFACT_TEMP_FILE.test(name);
}

/**
 * 완전히 기록된 같은-filesystem 임시 inode를 final path에 원자적으로 공개한다.
 * final path가 이미 있으면 기존 winner를 건드리지 않고 false를 반환한다.
 */
export async function claimImmutableBytesAtomic(
  path: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.immutable-artifact-${randomUUID()}.tmp`,
  );
  const desired = Buffer.from(bytes);

  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, desired, { flag: "wx" });
  try {
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }

    const stored = await readFile(path);
    if (Buffer.compare(stored, desired) !== 0) {
      throw new Error(`immutable artifact read-back mismatch: ${path}`);
    }
    return true;
  } finally {
    try {
      await unlink(temporaryPath);
    } catch {
      // final link의 성공/충돌 결과는 이미 확정됐다. 임시 파일 정리 실패가 그 결과를
      // ambiguous로 뒤집어 start slot을 영구 봉인하지 않도록 cleanup은 best-effort다.
    }
  }
}

export async function writeImmutableBytesAtomic(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const desired = Buffer.from(bytes);
  if (await claimImmutableBytesAtomic(path, desired)) return;

  const existing = await readFile(path);
  if (Buffer.compare(existing, desired) !== 0) {
    throw new Error(`immutable artifact conflict: ${path}`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
