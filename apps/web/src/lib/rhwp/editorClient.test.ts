import assert from "node:assert/strict";
import test from "node:test";
import type { RhwpEditor } from "@rhwp/editor";
import {
  applyEmbeddedRhwpStudioPresentation,
  embeddedRhwpStudioUrl,
  loadEditorFileWithoutDialogs,
} from "./editorClient";

test("임베드 Studio URL은 기존 query를 보존하고 호스트 수명주기 프로필을 강제한다", () => {
  assert.equal(
    embeddedRhwpStudioUrl("https://studio.example/?renderer=canvas2d&chrome=full"),
    "https://studio.example/?renderer=canvas2d&chrome=embed",
  );
});

test("임베드 Studio는 문서 로드 전에 밝은 플랫 스킨을 적용한다", async () => {
  const commands: string[] = [];
  const editor = {
    commands: {
      async execute(commandId: string) {
        commands.push(commandId);
        return { ok: true as const };
      },
    },
  } as unknown as Pick<RhwpEditor, "commands">;

  await applyEmbeddedRhwpStudioPresentation(editor);

  assert.deepEqual(commands, ["view:theme-light", "view:skin-flat"]);
});

test("임베드 Studio 표시 command가 거절되면 조용히 성공으로 가장하지 않는다", async () => {
  const editor = {
    commands: {
      async execute(commandId: string) {
        return commandId === "view:theme-light"
          ? { ok: true as const }
          : { ok: false as const, reason: "unsupported" };
      },
    },
  } as unknown as Pick<RhwpEditor, "commands">;

  await assert.rejects(
    applyEmbeddedRhwpStudioPresentation(editor),
    /view:skin-flat: unsupported/,
  );
});

test("호스트 초기 문서 로드는 iframe 확인창을 모두 우회한다", async () => {
  let received: unknown = null;
  const editor = {
    async loadFile(bytes: Uint8Array, filename: string, options: unknown) {
      received = { bytes: [...bytes], filename, options };
      return { pageCount: 1 };
    },
  } as unknown as RhwpEditor;

  await loadEditorFileWithoutDialogs(editor, new Uint8Array([1, 2, 3]), "working.hwpx");

  assert.deepEqual(received, {
    bytes: [1, 2, 3],
    filename: "working.hwpx",
    options: {
      skipUnsavedGuard: true,
      suppressDialogs: true,
    },
  });
});
