/**
 * layout 엔진 어댑터 레지스트리.
 * 러너는 name 으로 어댑터를 찾거나 전체를 순회한다.
 */
import type { LayoutEngineAdapter } from "../types";
import { upstageAdapter } from "./upstage";
import { googleDocaiAdapter } from "./google-docai";
import { azureDiAdapter } from "./azure-di";
import { kordocAdapter } from "./kordoc";
import { paddleocrAdapter } from "./paddleocr";

/** 등록 순서 = --engine all 실행 순서. */
export const ADAPTERS: readonly LayoutEngineAdapter[] = [
  upstageAdapter,
  googleDocaiAdapter,
  azureDiAdapter,
  kordocAdapter,
  paddleocrAdapter,
];

export const ADAPTER_NAMES: readonly string[] = ADAPTERS.map((a) => a.name);

export function getAdapter(name: string): LayoutEngineAdapter | undefined {
  return ADAPTERS.find((a) => a.name === name);
}
