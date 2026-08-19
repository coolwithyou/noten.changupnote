import assert from "node:assert/strict";
import test from "node:test";
import type { RhwpEditor } from "@rhwp/editor";
import { loadEditorFileWithoutDialogs } from "./editorClient";

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
