import type { RhwpEditor } from "@rhwp/editor";
import { exportVerifiedRhwpDocument, loadRhwp, type RhwpDocumentFormat } from "./client";

/** 자가 호스팅 rhwp Studio. 운영에서는 동일 제어 범위의 URL로 덮어쓴다. */
export const RHWP_STUDIO_URL =
  process.env.NEXT_PUBLIC_RHWP_STUDIO_URL ?? "https://changupnote-rhwp-studio.vercel.app/";

type RhwpEditorWithDocumentAgentLifecycle = RhwpEditor & {
  loadFile(
    bytes: Uint8Array,
    filename: string,
    options?: { skipUnsavedGuard?: boolean; suppressDialogs?: boolean },
  ): ReturnType<RhwpEditor["loadFile"]>;
  notifySaved?: () => Promise<void>;
};

/**
 * 호스트가 검증한 서버 작업본으로 새 embed 세션을 여는 경로다.
 *
 * Studio 내부의 이전 dirty/recovery 상태가 미저장 확인창을 열면 부모 로딩 overlay 뒤에서
 * 사용자 입력을 받을 수 없어 loadFile RPC가 교착된다. 이 초기 로드에는 사용자가 보존해야 할
 * iframe 변경이 아직 없으므로 unsaved guard와 후속 안내창을 모두 명시적으로 건너뛴다.
 */
export function loadEditorFileWithoutDialogs(
  editor: RhwpEditor,
  bytes: Uint8Array,
  filename: string,
): ReturnType<RhwpEditor["loadFile"]> {
  return (editor as RhwpEditorWithDocumentAgentLifecycle).loadFile(bytes, filename, {
    skipUnsavedGuard: true,
    suppressDialogs: true,
  });
}

/** 최신 SDK에서는 recovery draft를 지우고, 구 SDK에서는 안전한 no-op이다. */
export async function notifyEditorSaved(editor: RhwpEditor): Promise<void> {
  await (editor as RhwpEditorWithDocumentAgentLifecycle).notifySaved?.call(editor);
}

/** Studio에서 내보낸 실제 바이트를 rhwp core로 다시 열어 페이지 수까지 검증한다. */
export async function exportVerifiedEditorDocument(
  editor: RhwpEditor,
  format: RhwpDocumentFormat,
): Promise<Uint8Array> {
  const pageCountBefore = await editor.pageCount();
  let bytes: Uint8Array;
  if (format === "hwp") {
    const verification = await editor.exportHwpVerify();
    if (!verification.recovered) {
      throw new Error("rhwp가 내보낸 HWP를 다시 열지 못해 저장을 차단했습니다.");
    }
    if (verification.pageCountBefore !== verification.pageCountAfter) {
      throw new Error("HWP 자기 검증에서 페이지 수가 달라져 저장을 차단했습니다.");
    }
    bytes = await editor.exportHwp();
    if (bytes.byteLength !== verification.bytesLen) {
      throw new Error("HWP 검증본과 실제 저장본의 크기가 달라 저장을 차단했습니다.");
    }
  } else {
    bytes = await editor.exportHwpx();
  }
  if (bytes.byteLength === 0) throw new Error("rhwp Studio가 빈 파일을 만들어 저장을 차단했습니다.");

  const rhwp = await loadRhwp();
  const reopened = new rhwp.HwpDocument(bytes);
  try {
    const pageCountAfter = reopened.pageCount();
    if (pageCountBefore !== pageCountAfter) {
      throw new Error(
        `Studio 저장본을 다시 열었을 때 페이지 수가 ${pageCountBefore}쪽에서 ${pageCountAfter}쪽으로 달라졌습니다.`,
      );
    }
  } finally {
    reopened.free();
  }
  return bytes;
}

/** core 문서를 검증 내보낼 때 editorClient 사용처에서도 동일 계약을 재사용한다. */
export { exportVerifiedRhwpDocument };
