"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { maskLandingBizNo, type BizLookupModalState } from "./biz-lookup-utils";
import type { BizLookupController } from "./use-biz-lookup";

interface BizLookupDialogProps {
  controller: BizLookupController;
}

/**
 * 조회 결과 안내 다이얼로그. loading·confirm·error 3상을 한 Dialog로 처리한다.
 * Esc·바깥 클릭 → closeLookup. 확인/거절은 전용 버튼으로 상태를 비운다.
 */
export function BizLookupDialog({ controller }: BizLookupDialogProps) {
  const { lookup } = controller;

  return (
    <Dialog
      open={lookup !== null}
      onOpenChange={(open) => {
        if (!open) controller.closeLookup();
      }}
    >
      <DialogContent
        className="w-[calc(100%_-_2rem)] max-w-[360px] gap-0 rounded-[20px] p-0 shadow-[var(--shadow-elevated)] ring-0 sm:max-w-[360px]"
        overlayClassName="bg-[var(--overlay-scrim)] supports-backdrop-filter:backdrop-blur-[4px]"
        showCloseButton={false}
      >
        {lookup ? (
          <DialogBody lookup={lookup} controller={controller} />
        ) : (
          <DialogTitle className="sr-only">조회</DialogTitle>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({ lookup, controller }: { lookup: BizLookupModalState; controller: BizLookupController }) {
  if (lookup.phase === "loading") {
    return (
      <div className="px-[30px] py-9 text-center" aria-busy="true">
        <DialogHeader className="items-center gap-0">
          <span
            className="size-9 animate-spin rounded-full border-4 border-brand-tint border-t-brand"
            aria-hidden
          />
          <DialogTitle className="mt-5 text-[17px] leading-snug font-bold text-ink">
            사업자 정보를 확인하고 있어요
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-text-tertiary tabular-nums">
            {maskLandingBizNo(lookup.bizNo)}
          </DialogDescription>
        </DialogHeader>
      </div>
    );
  }

  if (lookup.phase === "confirm") {
    const statusLabel = lookup.preview.businessStatus?.label ?? null;
    const previewFacts = [lookup.preview.maskedBizNo, statusLabel, lookup.preview.regionLabel]
      .filter((value): value is string => Boolean(value))
      .join(" · ");

    return (
      <div className="px-7 py-[34px] text-center">
        <DialogHeader className="items-center gap-0">
          <DialogTitle className="text-[19px] leading-[1.45] font-extrabold text-ink">
            <span className="block">『{lookup.preview.name ?? "상호명 미확인"}』</span>
            회사가 맞으신가요?
          </DialogTitle>
          <DialogDescription className="mt-2.5 text-sm leading-relaxed text-text-secondary tabular-nums">
            {previewFacts}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="mx-0 mt-6 mb-0 flex-col items-stretch gap-[9px] border-0 bg-transparent p-0 sm:flex-col sm:justify-normal">
          <Button
            type="button"
            onClick={controller.confirmLookup}
            className="h-auto w-full py-3.5 text-[15px]"
          >
            네, 매칭 결과 보기
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={controller.rejectLookup}
            className="h-auto w-full py-3 text-sm"
          >
            아니요, 다시 입력할게요
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="px-7 py-[34px] text-center">
      <DialogHeader className="items-center gap-0">
        <span
          className="grid size-10 place-items-center rounded-full bg-surface-muted text-xl font-extrabold text-text-tertiary"
          aria-hidden
        >
          !
        </span>
        <DialogTitle className="mt-4 text-lg leading-snug font-extrabold text-ink">{lookup.title}</DialogTitle>
        <DialogDescription className="mt-2 text-sm leading-[1.55] text-text-secondary">
          {lookup.message}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter className="mx-0 mt-[22px] mb-0 flex-col items-stretch border-0 bg-transparent p-0 sm:flex-col sm:justify-normal">
        <DialogClose
          render={
            <Button type="button" className="h-auto w-full py-3.5 text-[15px]" />
          }
        >
          사업자번호 다시 입력
        </DialogClose>
      </DialogFooter>
    </div>
  );
}
