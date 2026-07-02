// @cunote/core 의 convertHwpBufferToMarkdown 을 convertDocument 에 주입하는 어댑터.
// core 를 직접 import 하는 유일한 지점 (테스트/샌드박스에서는 미주입해 fallback 사용).

import { convertHwpBufferToMarkdown } from "@cunote/core/bizinfo/hwp-markdown";
import type { HwpToMarkdownFn } from "./convert-document.js";

export const hwpToMarkdown: HwpToMarkdownFn = ({ filename, body }) => {
  const result = convertHwpBufferToMarkdown({ filename, body, autoInstallPyhwp: true });
  return { markdown: result.markdown, converter: result.converter };
};
