"use client";

import { createContext, useContext, type ReactNode } from "react";
import { BizLookupDialog } from "./biz-lookup-dialog";
import { useBizLookup, type BizLookupController } from "./use-biz-lookup";

const BizLookupContext = createContext<BizLookupController | null>(null);

/**
 * 랜딩 전역에 사업자번호 조회 컨트롤러를 공급한다.
 * 히어로·하단 CTA 폼이 동일 상태를 공유하고, 확인 다이얼로그를 한 번만 마운트한다.
 * 정적 마케팅 섹션은 서버 컴포넌트로 두고, 상호작용 리프만 이 컨텍스트를 구독한다.
 */
export function BizLookupProvider({ children }: { children: ReactNode }) {
  const controller = useBizLookup();
  return (
    <BizLookupContext.Provider value={controller}>
      {children}
      <BizLookupDialog controller={controller} />
    </BizLookupContext.Provider>
  );
}

export function useBizLookupController(): BizLookupController {
  const controller = useContext(BizLookupContext);
  if (!controller) {
    throw new Error("useBizLookupController must be used within BizLookupProvider");
  }
  return controller;
}
