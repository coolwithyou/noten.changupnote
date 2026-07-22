import type * as Rhwp from "@rhwp/core";
import type { HwpVerifyResult, RhwpEditor } from "@rhwp/editor";
export { downloadBytes, loadRhwp } from "@/lib/rhwp/client";

export type RhwpModule = typeof Rhwp;

/** 자가 호스팅 rhwp-studio (noten 팀 Vercel 정적 프로젝트) */
export const RHWP_STUDIO_URL =
  process.env.NEXT_PUBLIC_RHWP_STUDIO_URL ?? "https://changupnote-rhwp-studio.vercel.app/";

export async function exportVerifiedHwp(
  editor: RhwpEditor,
): Promise<{ bytes: Uint8Array; verification: HwpVerifyResult }> {
  const verification = await editor.exportHwpVerify();
  if (!verification.recovered) {
    throw new Error("rhwp가 내보낸 HWP를 다시 열지 못해 다운로드를 차단했습니다.");
  }
  if (verification.pageCountBefore !== verification.pageCountAfter) {
    throw new Error(
      `HWP 자기 재로드 후 페이지 수가 ${verification.pageCountBefore}쪽에서 ${verification.pageCountAfter}쪽으로 달라져 다운로드를 차단했습니다.`,
    );
  }
  const bytes = await editor.exportHwp();
  if (bytes.byteLength !== verification.bytesLen) {
    throw new Error(
      `검증본(${verification.bytesLen}B)과 다운로드본(${bytes.byteLength}B)의 크기가 달라 다운로드를 차단했습니다.`,
    );
  }
  return { bytes, verification };
}
