"use client";

import { AlertTriangle, ArrowRight, Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { Spinner } from "@/components/ui/spinner";
import { maskLandingBizNo, type BizLookupModalState } from "./biz-lookup-utils";
import type { BizLookupController } from "./use-biz-lookup";

interface BizLookupDialogProps {
  controller: BizLookupController;
}

/**
 * 조회 결과 안내 다이얼로그. loading·confirm·error 3상을 한 Dialog로 처리한다.
 * Esc·바깥 클릭·닫기 버튼 → closeLookup. 확인/거절은 전용 버튼으로 상태를 비운다.
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
      <DialogContent className="sm:max-w-md" showCloseButton={lookup?.phase !== "loading"}>
        {lookup ? <DialogBody lookup={lookup} controller={controller} /> : <DialogTitle className="sr-only">조회</DialogTitle>}
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({ lookup, controller }: { lookup: BizLookupModalState; controller: BizLookupController }) {
  if (lookup.phase === "loading") {
    return (
      <>
        <DialogHeader>
          <span className="grid size-12 place-items-center rounded-[var(--radius-lg)] bg-accent text-accent-foreground">
            <Spinner className="size-6" />
          </span>
          <DialogTitle>사업자 정보를 확인하고 있어요</DialogTitle>
          <DialogDescription>
            {maskLandingBizNo(lookup.bizNo)} 기준으로 상호와 영업상태를 확인 중이에요.
          </DialogDescription>
        </DialogHeader>
      </>
    );
  }

  if (lookup.phase === "confirm") {
    const suspended = lookup.preview.businessStatus?.active === false;
    const statusLabel = lookup.preview.businessStatus?.label ?? (suspended ? "휴업" : "영업 중");
    return (
      <>
        <DialogHeader>
          <span className="grid size-12 place-items-center rounded-[var(--radius-lg)] bg-brand-tint text-primary">
            <Building2 className="size-6" />
          </span>
          <DialogTitle>
            『{lookup.preview.name ?? "상호명 미확인"}』 회사가 맞으신가요?
          </DialogTitle>
          <DialogDescription>입력하신 사업자번호로 확인한 정보예요.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="tabular-nums">
            {lookup.preview.maskedBizNo}
          </Badge>
          <Badge variant={suspended ? "destructive" : "secondary"}>{statusLabel}</Badge>
          {lookup.preview.regionLabel ? (
            <Badge variant="secondary">{lookup.preview.regionLabel}</Badge>
          ) : null}
        </div>

        {suspended ? (
          <p className="text-sm text-muted-foreground">
            국세청 기준 {statusLabel} 상태예요. 그래도 매칭 결과는 확인할 수 있어요.
          </p>
        ) : null}
        {lookup.preview.name === null ? (
          <p className="text-sm text-muted-foreground">
            상호명을 확인하지 못했어요. 번호가 맞다면 그대로 진행할 수 있어요.
          </p>
        ) : null}

        <DialogFooter className="flex-col items-stretch sm:flex-col sm:justify-normal">
          <Button type="button" onClick={controller.confirmLookup} className="bg-[image:var(--grad-cta)]">
            네, 매칭 결과 보기
            <ArrowRight data-icon="inline-end" />
          </Button>
          <Button type="button" variant="outline" onClick={controller.rejectLookup}>
            아니요, 다시 입력할게요
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <span className="grid size-12 place-items-center rounded-[var(--radius-lg)] bg-destructive/10 text-destructive">
          <AlertTriangle className="size-6" />
        </span>
        <DialogTitle>{lookup.title}</DialogTitle>
        <DialogDescription>{lookup.message}</DialogDescription>
      </DialogHeader>
      <DialogFooter className="flex-col items-stretch sm:flex-col sm:justify-normal">
        <DialogClose render={<Button type="button" className="bg-[image:var(--grad-cta)]" />}>
          사업자번호 다시 입력
        </DialogClose>
      </DialogFooter>
    </>
  );
}
