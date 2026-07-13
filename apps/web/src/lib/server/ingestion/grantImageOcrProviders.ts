import type { GrantImageOcrAdapter } from "./grantAttachmentArchive";
import { macosVisionGrantImageOcr } from "./macosVisionOcr";
import { paddleOcrGrantImageOcr, paddleOcrServerUrl } from "./paddleOcrImage";

export const GRANT_IMAGE_OCR_PROVIDERS = ["none", "macos_vision", "paddleocr"] as const;
export type GrantImageOcrProvider = typeof GRANT_IMAGE_OCR_PROVIDERS[number];

export function resolveGrantImageOcrAdapter(provider: GrantImageOcrProvider): GrantImageOcrAdapter | null {
  if (provider === "none") return null;
  if (provider === "macos_vision") {
    if (process.platform !== "darwin") throw new Error("--imageOcr=macos_vision requires macOS");
    return macosVisionGrantImageOcr;
  }
  if (!paddleOcrServerUrl()) throw new Error("--imageOcr=paddleocr requires PADDLEOCR_SERVER_URL");
  return paddleOcrGrantImageOcr;
}

export function parseGrantImageOcrProvider(value: string | undefined): GrantImageOcrProvider {
  if (!value) return "none";
  if ((GRANT_IMAGE_OCR_PROVIDERS as readonly string[]).includes(value)) return value as GrantImageOcrProvider;
  throw new Error(`Invalid imageOcr: ${value}. Use ${GRANT_IMAGE_OCR_PROVIDERS.join("|")}.`);
}
