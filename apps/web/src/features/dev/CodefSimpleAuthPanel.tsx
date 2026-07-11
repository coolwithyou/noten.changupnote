"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { CodefFlowResult, CodefProfileFields } from "@/lib/server/codef/orchestrator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";

// ─────────────────────────────────────────────────────────────────────────────
// CODEF 간편인증 패널(dev 전용). 사업자번호 + 본인확인 입력 → 인증앱 승인 대기 → [승인 완료]
// (폴링 아님, 사용자가 앱에서 승인 후 탭) → 국세청 확정값 요약. 두 HTTP 요청으로 2-way 세션을
// 완결한다. 생년월일·전화·성별 원본은 화면 상태에만 두고 로컬스토리지·URL·로그에 남기지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 인증앱 코드맵 — 값은 orchestrator StartSimpleAuthInput.authApp(CodefSimpleAuthApp) 키와 정확히 일치. */
const AUTH_APPS = [
  { value: "kakaotalk", label: "카카오톡" },
  { value: "samsungPass", label: "삼성패스" },
  { value: "kbMobile", label: "KB모바일" },
  { value: "pass", label: "통신사(PASS)" },
  { value: "naver", label: "네이버" },
  { value: "shinhan", label: "신한인증서" },
  { value: "toss", label: "toss" },
  { value: "banksalad", label: "뱅크샐러드" },
  { value: "nh", label: "NH인증서" },
  { value: "woori", label: "우리인증서" },
] as const;

type AuthAppValue = (typeof AUTH_APPS)[number]["value"];

/** 통신사 코드(PASS 간편인증에서만 필요). */
const TELECOMS = [
  { value: "0", label: "SKT" },
  { value: "1", label: "KT" },
  { value: "2", label: "LG U+" },
] as const;

/** 성별(선택) — founder_trait 파생용. */
const GENDERS = [
  { value: "M", label: "남성" },
  { value: "F", label: "여성" },
] as const;

type Phase =
  | "idle"
  | "submitting"
  | "pending"
  | "second_approval"
  | "completing"
  | "done"
  | "failed"
  | "expired";

interface CodefSimpleAuthPanelProps {
  /** 상위 모니터가 조회 중인 사업자번호(있으면 폼에 채워 공유). */
  defaultBizNo?: string;
  /** 인증 완료(done) 시 호출 — 상위가 커버리지 재조회로 병합을 갱신하도록. */
  onCompleted?: (bizNo: string) => void;
}

export function CodefSimpleAuthPanel({ defaultBizNo, onCompleted }: CodefSimpleAuthPanelProps) {
  const [bizNo, setBizNo] = useState(defaultBizNo ?? "");
  const [name, setName] = useState("");
  const [birth8, setBirth8] = useState("");
  const [phone, setPhone] = useState("");
  const [authApp, setAuthApp] = useState<AuthAppValue>("kakaotalk");
  const [telecom, setTelecom] = useState("");
  const [gender, setGender] = useState("");
  const [consent, setConsent] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [guide, setGuide] = useState("");
  const [fields, setFields] = useState<CodefProfileFields | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const deadlineRef = useRef<number | null>(null);

  // 상위 모니터가 새 사업자번호를 조회하면 폼에 반영(비어있지 않을 때만).
  useEffect(() => {
    if (defaultBizNo) setBizNo(defaultBizNo);
  }, [defaultBizNo]);

  // 승인 대기 상태의 남은 시간 카운트다운(4분30초). 폴링이 아니라 표시용 타이머.
  useEffect(() => {
    if (phase !== "pending" && phase !== "second_approval") return;
    const tick = () => {
      if (deadlineRef.current === null) return;
      setRemainingMs(Math.max(0, deadlineRef.current - Date.now()));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const bizDigits = bizNo.replace(/\D/g, "");
  const birthDigits = birth8.replace(/\D/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  const needsTelecom = authApp === "pass";
  const formValid =
    bizDigits.length === 10 &&
    name.trim().length > 0 &&
    birthDigits.length === 8 &&
    phoneDigits.length >= 10 &&
    phoneDigits.length <= 11 &&
    (!needsTelecom || telecom !== "") &&
    consent;

  const inProgress = phase === "submitting" || phase === "completing";
  const awaiting = phase === "pending" || phase === "second_approval";
  // 승인 대기 박스는 완료 요청 중(completing)에도 유지해 스피너를 보여준다.
  const showWaiting = awaiting || phase === "completing";

  const applyResult = useCallback((result: CodefFlowResult) => {
    setSessionId(result.sessionId ?? null);
    if (result.state === "pending" || result.state === "second_approval_needed") {
      setPhase(result.state === "pending" ? "pending" : "second_approval");
      setGuide(result.guide);
      deadlineRef.current = Date.now() + result.remainingMs;
      setRemainingMs(result.remainingMs);
      setErrorText(null);
      return;
    }
    if (result.state === "done") {
      setPhase("done");
      setFields(result.fields);
      setErrorText(null);
      return;
    }
    if (result.state === "expired") {
      setPhase("expired");
      setErrorText("세션이 만료되었습니다(4분 30초 초과). 다시 시작해주세요.");
      return;
    }
    // failed
    setPhase("failed");
    setErrorText(result.errorCode ? `${result.error} (${result.errorCode})` : result.error);
  }, []);

  const start = useCallback(async () => {
    if (!formValid) return;
    setPhase("submitting");
    setErrorText(null);
    setFields(null);
    try {
      const res = await fetch("/api/dev/codef/simple-auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bizNo: bizDigits,
          name: name.trim(),
          birth8: birthDigits,
          phone: phoneDigits,
          authApp,
          ...(needsTelecom && telecom ? { telecom } : {}),
          ...(gender ? { gender } : {}),
        }),
      });
      const data = (await res.json()) as CodefFlowResult & { message?: string; error?: string };
      if (!res.ok) {
        setPhase("idle");
        toast.error(data.message ?? "간편인증 시작에 실패했습니다.");
        return;
      }
      applyResult(data);
    } catch {
      setPhase("idle");
      toast.error("네트워크 오류로 간편인증을 시작하지 못했습니다.");
    }
  }, [applyResult, authApp, birthDigits, bizDigits, formValid, gender, name, needsTelecom, phoneDigits, telecom]);

  const complete = useCallback(async () => {
    if (!sessionId) return;
    const prevPhase = phase;
    setPhase("completing");
    try {
      const res = await fetch("/api/dev/codef/simple-auth/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json()) as CodefFlowResult & { message?: string; error?: string };
      if (!res.ok) {
        setPhase(prevPhase);
        toast.error(data.message ?? "완료 처리에 실패했습니다.");
        return;
      }
      // 아직 앱 승인 전이면 서버가 pending 을 되돌린다 — 안내만 하고 대기 유지.
      if (data.state === "pending") {
        toast.info("아직 승인 전입니다. 인증앱에서 승인한 뒤 다시 눌러주세요.");
      }
      applyResult(data);
      if (data.state === "done") {
        toast.success("국세청 확정값을 받아왔습니다.");
        onCompleted?.(bizDigits);
      }
    } catch {
      setPhase(prevPhase);
      toast.error("네트워크 오류로 완료 처리를 하지 못했습니다.");
    }
  }, [applyResult, bizDigits, onCompleted, phase, sessionId]);

  const reset = useCallback(() => {
    setPhase("idle");
    setSessionId(null);
    setGuide("");
    setFields(null);
    setErrorText(null);
    deadlineRef.current = null;
    setRemainingMs(0);
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">CODEF 간편인증</CardTitle>
          <Badge variant="outline">dev</Badge>
          <Badge variant="secondary">국세청 확정값</Badge>
        </div>
        <CardDescription>
          본인확인 입력 후 인증앱(카카오톡 등)에서 승인하면 국세청 확정값(소재지·업력·업종·대상유형·매출·
          대표자 연령/특성)을 받아 위 커버리지에 <span className="font-medium">국세청(CODEF)</span> 원천으로
          병합합니다. 생년월일·전화 원본은 화면에만 두고 저장하지 않습니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* 입력 폼 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codef-biz-no">사업자등록번호</Label>
            <Input
              id="codef-biz-no"
              inputMode="numeric"
              placeholder="10자리 (하이픈 무시)"
              value={bizNo}
              disabled={awaiting || inProgress}
              onChange={(event) => setBizNo(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codef-name">이름</Label>
            <Input
              id="codef-name"
              placeholder="대표자 성명"
              value={name}
              disabled={awaiting || inProgress}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codef-birth">생년월일 (yyyyMMdd)</Label>
            <Input
              id="codef-birth"
              inputMode="numeric"
              placeholder="예: 19850101"
              maxLength={8}
              value={birth8}
              disabled={awaiting || inProgress}
              onChange={(event) => setBirth8(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codef-phone">휴대폰번호</Label>
            <Input
              id="codef-phone"
              inputMode="numeric"
              placeholder="숫자만 (하이픈 무시)"
              value={phone}
              disabled={awaiting || inProgress}
              onChange={(event) => setPhone(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codef-app">인증앱</Label>
            <Select
              items={AUTH_APPS.map((app) => ({ label: app.label, value: app.value }))}
              value={authApp}
              disabled={awaiting || inProgress}
              onValueChange={(value) => {
                if (typeof value === "string") setAuthApp(value as AuthAppValue);
              }}
            >
              <SelectTrigger id="codef-app" className="w-full">
                <SelectValue placeholder="인증앱 선택" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {AUTH_APPS.map((app) => (
                    <SelectItem key={app.value} value={app.value}>
                      {app.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {needsTelecom ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="codef-telecom">통신사 (PASS)</Label>
              <Select
                items={TELECOMS.map((t) => ({ label: t.label, value: t.value }))}
                value={telecom}
                disabled={awaiting || inProgress}
                onValueChange={(value) => {
                  if (typeof value === "string") setTelecom(value);
                }}
              >
                <SelectTrigger id="codef-telecom" className="w-full">
                  <SelectValue placeholder="통신사 선택" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {TELECOMS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codef-gender">성별 (선택)</Label>
            <Select
              items={GENDERS.map((g) => ({ label: g.label, value: g.value }))}
              value={gender}
              disabled={awaiting || inProgress}
              onValueChange={(value) => {
                if (typeof value === "string") setGender(value);
              }}
            >
              <SelectTrigger id="codef-gender" className="w-full">
                <SelectValue placeholder="선택 안 함" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {GENDERS.map((g) => (
                    <SelectItem key={g.value} value={g.value}>
                      {g.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Label htmlFor="codef-consent" className="font-normal">
          <Checkbox
            id="codef-consent"
            checked={consent}
            disabled={awaiting || inProgress}
            onCheckedChange={(checked) => setConsent(checked === true)}
          />
          홈택스(국세청) 정보 조회에 동의합니다.
        </Label>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void start()} disabled={!formValid || awaiting || inProgress}>
            {phase === "submitting" ? <Spinner className="size-4" /> : null}
            간편인증 시작
          </Button>
          {phase !== "idle" ? (
            <Button variant="outline" onClick={reset} disabled={inProgress}>
              초기화
            </Button>
          ) : null}
        </div>

        {/* 승인 대기 / 결과 */}
        {showWaiting ? (
          <>
            <Separator />
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Spinner className="size-4" />
                <span className="text-sm font-medium">
                  {phase === "completing"
                    ? "승인 확인 중…"
                    : phase === "second_approval"
                      ? "부가세 조회에 2차 승인이 필요합니다."
                      : "인증앱에서 승인해주세요."}
                </span>
                <Badge variant="outline">남은 시간 {formatCountdown(remainingMs)}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{guide}</p>
              {remainingMs <= 0 ? (
                <p className="text-xs text-destructive">
                  제한시간이 지났습니다. 완료를 눌러도 만료될 수 있으니 다시 시작해주세요.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void complete()} disabled={phase === "completing"}>
                  {phase === "completing" ? <Spinner className="size-4" /> : null}
                  승인 완료
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {phase === "done" && fields ? (
          <>
            <Separator />
            <DoneFields fields={fields} />
          </>
        ) : null}

        {(phase === "failed" || phase === "expired") && errorText ? (
          <>
            <Separator />
            <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <span className="text-sm font-medium text-destructive">
                {phase === "expired" ? "세션 만료" : "인증 실패"}
              </span>
              <p className="text-sm text-muted-foreground">{errorText}</p>
              <div>
                <Button variant="outline" onClick={reset}>
                  다시 시작
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── 결과 요약(생년월일 원본 표시/저장 없음 · 연령 파생만) ─────────────────────────

function DoneFields({ fields }: { fields: CodefProfileFields }) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "상호", value: fields.name ?? "—" },
    { label: "소재지", value: fields.region ?? "—" },
    { label: "업력", value: formatBizAge(fields.biz_age_months) },
    { label: "업종", value: fields.industries.length ? fields.industries.join(", ") : "—" },
    { label: "대상 유형", value: fields.target_type ?? "—" },
    { label: "매출(과세표준)", value: formatKrw(fields.revenue_krw) },
    { label: "대표자 연령", value: fields.founder_age !== null ? `${fields.founder_age}세` : "—" },
    { label: "대표자 성별", value: genderLabel(fields.gender) },
  ];
  if (fields.masked_identity_no) rows.push({ label: "식별번호(마스킹)", value: fields.masked_identity_no });
  if (fields.joint_representative) rows.push({ label: "공동대표", value: fields.joint_representative });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">국세청 확정값</span>
        <Badge className="bg-primary text-primary-foreground">국세청(CODEF)</Badge>
        {fields.vat_available ? (
          <Badge variant="secondary">부가세 신고분 반영</Badge>
        ) : (
          <Badge variant="outline" className="border-dashed text-muted-foreground">
            부가세 없음(사업자등록증명만)
          </Badge>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4 border-b border-border/60 pb-1.5">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-right font-medium break-all">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── 순수 헬퍼 ────────────────────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBizAge(months: number | null): string {
  if (months === null || !Number.isFinite(months) || months < 0) return "—";
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years > 0 && rem > 0) return `${years}년 ${rem}개월`;
  if (years > 0) return `${years}년`;
  return `${rem}개월`;
}

function formatKrw(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 100_000_000) {
    const eok = Math.round((abs / 100_000_000) * 10) / 10;
    return `${sign}${eok.toLocaleString("ko-KR")}억원`;
  }
  if (abs >= 10_000) return `${sign}${Math.round(abs / 10_000).toLocaleString("ko-KR")}만원`;
  return `${sign}${abs.toLocaleString("ko-KR")}원`;
}

function genderLabel(gender: "M" | "F" | null): string {
  if (gender === "M") return "남성";
  if (gender === "F") return "여성";
  return "—";
}
