import type { RhwpEditor } from "@rhwp/editor";
import { exportVerifiedRhwpDocument, loadRhwp, type RhwpDocumentFormat } from "./client";

const DEFAULT_RHWP_STUDIO_URL = "https://changupnote-rhwp-studio.vercel.app/";
const EMBEDDED_STUDIO_COMMANDS = ["view:theme-light", "view:skin-flat"] as const;

/** 호스트가 문서 수명주기를 소유하므로 Studio의 로컬 파일 명령을 숨긴다. */
export function embeddedRhwpStudioUrl(studioUrl: string): string {
  const url = new URL(studioUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RHWP Studio URL은 HTTP(S) 주소여야 합니다.");
  }
  url.searchParams.set("chrome", "embed");
  return url.href;
}

/** 자가 호스팅 rhwp Studio. 운영에서는 동일 제어 범위의 URL로 덮어쓴다. */
export const RHWP_STUDIO_URL = embeddedRhwpStudioUrl(
  process.env.NEXT_PUBLIC_RHWP_STUDIO_URL ?? DEFAULT_RHWP_STUDIO_URL,
);

/** 문서를 열기 전에 밝은 플랫 스킨을 적용해 불필요한 문서 재렌더를 피한다. */
export async function applyEmbeddedRhwpStudioPresentation(
  editor: Pick<RhwpEditor, "commands">,
): Promise<void> {
  const results = await Promise.all(
    EMBEDDED_STUDIO_COMMANDS.map(async (commandId) => ({
      commandId,
      result: await editor.commands.execute(commandId),
    })),
  );
  const failed = results.find(({ result }) => !result.ok);
  if (failed && !failed.result.ok) {
    throw new Error(
      `RHWP Studio 표시 설정을 적용하지 못했습니다. (${failed.commandId}: ${failed.result.reason})`,
    );
  }
}

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
