"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import type { ActionResult, CompanyProfile, TeaserRequest } from "@cunote/contracts";
import { ArrowRight, Building2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/app/status-badge";
import { KOREA_REGION_OPTIONS } from "@/lib/regions";

export function InitialCompanySetupPanel({ nextHref }: { nextHref: string }) {
  const [bizNo, setBizNo] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [regionCode, setRegionCode] = useState<string | null>(null);
  const [industries, setIndustries] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const bizNoId = useId();
  const companyNameId = useId();
  const regionId = useId();
  const industriesId = useId();
  const normalizedBizNo = useMemo(() => bizNo.replace(/\D/g, ""), [bizNo]);

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);

    const requestBody = buildCreateRequest({
      bizNo: normalizedBizNo,
      companyName,
      regionCode,
      industries,
    });
    if (!requestBody) {
      setError("사업자번호 10자리 또는 회사명, 지역, 업종 중 하나를 입력하세요.");
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/web/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json() as ActionResult<{ currentCompanyId: string }>;
      if (response.status === 401 && payload.error?.code === "auth_required") {
        const params = new URLSearchParams({ callbackUrl: onboardingHref(nextHref) });
        window.location.assign(`/login?${params.toString()}`);
        return;
      }
      if (!response.ok || !payload.ok || !payload.data?.currentCompanyId) {
        throw new Error(payload.error?.message ?? "회사 프로필을 만들지 못했습니다.");
      }
      setStatus("회사 프로필을 만들었습니다. 이어서 이동합니다.");
      window.location.assign(nextHref);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "회사 프로필을 만들지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card id="initial-company-setup">
      <CardHeader>
        <CardTitle>회사 프로필 만들기</CardTitle>
        <CardDescription>첫 회사 데이터를 만들면 추천, 로드맵, 신청서류 초안이 같은 기준으로 작동합니다.</CardDescription>
        <CardAction>
          <StatusBadge tone="warning">필수</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Alert>
          <Building2 aria-hidden />
          <AlertTitle>회사 프로필이 필요합니다</AlertTitle>
          <AlertDescription>
            기회 맵, 로드맵, 신청서류 초안은 모두 회사 프로필을 기준으로 계산됩니다. 사업자번호가 있으면 바로 조회하고,
            없으면 수기 프로필로 먼저 시작할 수 있습니다.
          </AlertDescription>
        </Alert>

        <form className="flex flex-col gap-4" onSubmit={createCompany}>
          <FieldGroup className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={bizNoId}>사업자번호</FieldLabel>
              <Input
                id={bizNoId}
                inputMode="numeric"
                placeholder="사업자번호 10자리"
                value={bizNo}
                disabled={pending}
                onChange={(event) => setBizNo(event.currentTarget.value.replace(/[^\d-]/g, ""))}
              />
              <FieldDescription>사업자번호가 있으면 회사 기본 정보를 먼저 조회합니다.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={companyNameId}>회사명</FieldLabel>
              <Input
                id={companyNameId}
                placeholder="회사명 또는 서비스명"
                value={companyName}
                disabled={pending}
                onChange={(event) => setCompanyName(event.currentTarget.value)}
              />
              <FieldDescription>사업자번호가 없을 때 수기 프로필 이름으로 사용합니다.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={regionId}>소재 지역</FieldLabel>
              <Select
                items={KOREA_REGION_OPTIONS.map((region) => ({ label: region.label, value: region.code }))}
                value={regionCode}
                disabled={pending}
                onValueChange={(value) => {
                  if (typeof value === "string") setRegionCode(value);
                }}
              >
                <SelectTrigger id={regionId} className="w-full">
                  <SelectValue placeholder="지역 선택" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {KOREA_REGION_OPTIONS.map((region) => (
                      <SelectItem key={region.code} value={region.code}>
                        {region.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor={industriesId}>업종/키워드</FieldLabel>
              <Input
                id={industriesId}
                placeholder="ICT, SaaS, 제조"
                value={industries}
                disabled={pending}
                onChange={(event) => setIndustries(event.currentTarget.value)}
              />
              <FieldDescription>쉼표로 여러 키워드를 입력할 수 있습니다.</FieldDescription>
            </Field>
          </FieldGroup>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}

          <Button className="w-fit" type="submit" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "만드는 중" : "회사 프로필 만들기"}
            {pending ? null : <ArrowRight data-icon="inline-end" />}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function onboardingHref(nextHref: string): string {
  return `/onboarding?${new URLSearchParams({ next: nextHref }).toString()}`;
}

function buildCreateRequest(input: {
  bizNo: string;
  companyName: string;
  regionCode: string | null;
  industries: string;
}): Partial<TeaserRequest> | null {
  if (input.bizNo.length > 0 && input.bizNo.length !== 10) return null;
  if (input.bizNo.length === 10) return { bizNo: input.bizNo };

  const region = KOREA_REGION_OPTIONS.find((option) => option.code === input.regionCode);
  const industryTags = splitList(input.industries);
  const name = input.companyName.trim();
  if (!name && !region && industryTags.length === 0) return null;

  const profile: CompanyProfile = {
    is_preliminary: true,
    confidence: {},
  };
  if (name) profile.name = name;
  if (region) {
    profile.region = { code: region.code, label: region.label };
    profile.confidence!.region = 0.55;
  }
  if (industryTags.length > 0) {
    profile.industries = industryTags;
    profile.confidence!.industry = 0.35;
  }
  return { profile };
}

function splitList(value: string): string[] {
  return [...new Set(value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean))];
}
