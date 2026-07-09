"use client";

import { CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ActionResult, CompanyPreviewResult, LandingGrantData, TeaserRequest } from "@cunote/contracts";
import { isValidBizNoChecksum } from "@cunote/contracts";
import { AccountMenu } from "@/components/app/account-menu";
import { normalizeBusinessLookupBizNo, type BusinessLookupSuggestion } from "@/lib/businessLookupSuggestions";
import {
  fetchBusinessLookupSuggestions,
  readLocalBusinessLookupSuggestions,
} from "@/lib/client/businessLookupSuggestions";
import { recordLandingEvent } from "@/lib/client/landingEvents";
import type { HeaderUser } from "@/lib/server/auth/session";

/*
 * 창업노트 랜딩 — Claude Design 핸드오프 "창업노트 랜딩.dc.html" 픽셀 포트.
 * 디자인 충실도를 위해 dc.html 의 인라인 스타일을 그대로 옮긴다(토큰/shadcn 근사 X).
 * 데이터 배선만 추가: 지원 가능 건수, 사업자번호 입력 → /matches, FAQ 아코디언.
 */

const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";

/**
 * 사업자번호 제출 → /matches 이동 사이에 끼는 확인 모달 상태.
 * 무효·미등록·휴폐업은 랜딩을 떠나지 않고 모달로 안내하고,
 * 정상 확인("네, 맞아요")된 번호만 /matches?biz= 로 넘어간다.
 */
type BizLookupModalState =
  | { phase: "loading"; bizNo: string }
  | { phase: "confirm"; bizNo: string; preview: CompanyPreviewResult }
  | { phase: "error"; bizNo: string; title: string; message: string };

const FAQS = [
  {
    q: "정말 사업자번호만 넣으면 되나요?",
    a: "네. 사업자번호로 공개된 사업자 정보를 불러와 표준화된 지원사업과 자동으로 대조해요. 추가 입력 없이 조회가 시작돼요.",
  },
  {
    q: "회원가입을 꼭 해야 하나요?",
    a: "조회는 회원가입 없이 가능해요. 결과를 저장하거나 신청 코칭을 받을 때부터 계정이 필요해요.",
  },
  {
    q: "어떤 지원사업을 다루나요?",
    a: "중소벤처기업부·소상공인시장진흥공단·KOTRA·한국콘텐츠진흥원 등 40여 개 기관의 공고를 매주 수집해 한 형식으로 표준화해요.",
  },
  {
    q: "적합도는 어떻게 계산되나요?",
    a: "업종·업력·지역·매출 같은 회사 정보와 공고의 자격요건을 항목별로 대조해 적합도 점수를 매겨요.",
  },
  {
    q: "비용이 있나요?",
    a: "지원사업 조회와 매칭은 무료예요. 팀 단위 신청 관리 기능은 도입 문의를 통해 안내해 드려요.",
  },
];

const NOISE_BG =
  "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22%3E%3Cfilter id=%22n%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.85%22 numOctaves=%222%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22/%3E%3C/svg%3E')";

const GRAD_BTN = "linear-gradient(180deg,#4790ff,#3182f6)";
const GRAD_TEXT = "linear-gradient(120deg,#3182f6,#2bd4a8)";
const GRAD_BAR = "linear-gradient(90deg,#2bd4a8,#3182f6)";
const LANDING_LOGIN_HREF = `/login?${new URLSearchParams({ callbackUrl: "/" }).toString()}`;

interface LandingExperienceProps {
  landingData: LandingGrantData;
  user?: HeaderUser | null;
}

export function LandingExperience({ landingData, user = null }: LandingExperienceProps) {
  const [biz, setBiz] = useState("");
  const [lookupSuggestions, setLookupSuggestions] = useState<BusinessLookupSuggestion[]>([]);
  const [lookup, setLookup] = useState<BizLookupModalState | null>(null);
  const [faq, setFaq] = useState(0);
  const lookupSeqRef = useRef(0);
  const heroBizInputRef = useRef<HTMLInputElement | null>(null);
  const activeCount = landingData.stats.activeCount.toLocaleString("ko-KR");
  const visibleLookupSuggestions = useMemo(
    () => filterLandingLookupSuggestions(lookupSuggestions, onlyDigits(biz)),
    [lookupSuggestions, biz],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("resumeCompany") !== "1") return;
    const resumeGrant = params.get("resumeGrant");
    clearResumeFlag(params);
    const pending = readPendingTeaserRequest();
    if (pending?.bizNo) void createCompanyAndOpenDashboard(pending, resumeGrant);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const localSuggestions = readLocalBusinessLookupSuggestions();
    if (localSuggestions.length > 0) {
      setLookupSuggestions(localSuggestions);
    }

    fetchBusinessLookupSuggestions().then((result) => {
      if (cancelled || !result) return;
      if (result.authenticated) {
        setLookupSuggestions(result.suggestions);
      } else if (localSuggestions.length === 0) {
        setLookupSuggestions(readLocalBusinessLookupSuggestions());
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  function onBizInput(value: string) {
    setBiz(fmtBiz(value));
  }

  function selectLookupSuggestion(suggestion: BusinessLookupSuggestion) {
    setBiz(fmtBiz(suggestion.bizNo));
  }

  useEffect(() => {
    if (!lookup) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissLookup("closed");
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
    // dismissLookup은 ref/setState만 쓰므로 모달 열림 여부만 의존한다.
  }, [Boolean(lookup)]);

  function submitBiz(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lookup?.phase === "loading") return;
    const digits = onlyDigits(biz);
    const requestId = crypto.randomUUID();
    if (digits.length !== 10) {
      recordLandingEvent({
        event: "biz_no_validation_failed",
        requestId,
        inputLength: digits.length,
        reason: "length_not_10",
      });
      setLookup({
        phase: "error",
        bizNo: digits,
        title: "사업자번호를 확인해 주세요",
        message: "사업자번호 10자리를 입력해주세요.",
      });
      return;
    }
    if (!isValidBizNoChecksum(digits)) {
      recordLandingEvent({
        event: "biz_no_validation_failed",
        requestId,
        inputLength: digits.length,
        reason: "checksum_failed",
      });
      setLookup({
        phase: "error",
        bizNo: digits,
        title: "사업자번호를 다시 확인해 주세요",
        message: "유효하지 않은 사업자등록번호입니다. 입력한 번호를 다시 확인해주세요.",
      });
      return;
    }
    void requestCompanyPreview(digits, requestId);
  }

  async function requestCompanyPreview(digits: string, requestId: string) {
    const seq = ++lookupSeqRef.current;
    setLookup({ phase: "loading", bizNo: digits });
    recordLandingEvent({ event: "company_preview_requested", requestId, inputLength: digits.length });
    const startedAt = performance.now();

    try {
      const response = await fetch("/api/web/company-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bizNo: digits }),
      });
      const payload = await response.json() as ActionResult<CompanyPreviewResult>;
      if (seq !== lookupSeqRef.current) return;
      if (!response.ok || !payload.ok || !payload.data) {
        recordLandingEvent({
          event: "company_preview_failed",
          requestId,
          durationMs: performance.now() - startedAt,
          errorCode: payload.error?.code ?? `http_${response.status}`,
        });
        setLookup({
          phase: "error",
          bizNo: digits,
          title: titleForPreviewError(payload.error?.code),
          message: payload.error?.message ?? "회사 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
        });
        return;
      }
      recordLandingEvent({
        event: "company_preview_succeeded",
        requestId,
        durationMs: performance.now() - startedAt,
      });
      setLookup({ phase: "confirm", bizNo: digits, preview: payload.data });
    } catch {
      if (seq !== lookupSeqRef.current) return;
      recordLandingEvent({
        event: "company_preview_failed",
        requestId,
        durationMs: performance.now() - startedAt,
        errorCode: "network_error",
      });
      setLookup({
        phase: "error",
        bizNo: digits,
        title: "잠시 후 다시 시도해 주세요",
        message: "네트워크 문제로 회사 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
      });
    }
  }

  function confirmLookup() {
    if (lookup?.phase !== "confirm") return;
    recordLandingEvent({ event: "company_confirmed" });
    window.location.assign(`/matches?biz=${lookup.bizNo}`);
  }

  function dismissLookup(reason: "rejected" | "closed") {
    if (lookup?.phase === "confirm" && reason === "rejected") {
      recordLandingEvent({ event: "company_rejected" });
    }
    lookupSeqRef.current += 1; // 진행 중인 preview 응답은 무시
    setLookup(null);
    heroBizInputRef.current?.focus();
  }

  return (
    <main className="lp-root" style={{ width: "100%", overflowX: "hidden" }}>
      {/* ============ NAV ============ */}
      <nav
        style={{
          position: "sticky",
          top: 0,
          zIndex: 80,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "14px clamp(20px,5vw,40px)",
          background: "rgba(251,251,252,.78)",
          backdropFilter: "blur(14px)",
          borderBottom: "1px solid #ecf0f3",
        }}
      >
        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            fontWeight: 700,
            fontSize: 17,
            letterSpacing: "-.03em",
            color: "#191f28",
          }}
        >
          <BrandMark size={26} />
          <span style={{ fontWeight: 800 }}>창업노트</span>
        </Link>

        <div className="lp-nav-links" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <a className="lp-navlink" href="#how">작동 방식</a>
          <a className="lp-navlink" href="#features">기능</a>
          <a className="lp-navlink" href="#faq">자주 묻는 질문</a>
        </div>

        <div className="lp-nav-actions" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {user ? (
            <>
              <Link className="lp-primary-cta" href="/dashboard" style={gradientPill(9, 18)}>기회 맵</Link>
              <AccountMenu user={user} />
            </>
          ) : (
            <>
              <Link
                href={LANDING_LOGIN_HREF}
                style={{
                  fontSize: 14.5,
                  fontWeight: 600,
                  color: "#4e5968",
                  padding: "9px 16px",
                  borderRadius: 999,
                  border: "1px solid #e5e8eb",
                  background: "#fff",
                }}
              >
                로그인
              </Link>
              <Link className="lp-primary-cta" href={LANDING_LOGIN_HREF} style={gradientPill(9, 18)}>무료로 시작</Link>
            </>
          )}
        </div>
      </nav>

      {/* ============ HERO ============ */}
      <header
        style={{
          position: "relative",
          overflow: "hidden",
          padding: "clamp(64px,9vw,108px) clamp(20px,5vw,40px) clamp(64px,8vw,92px)",
          textAlign: "center",
          background:
            "radial-gradient(46% 46% at 14% 6%,#e1ecff 0%,transparent 60%),radial-gradient(40% 44% at 90% 4%,#d6f7ec 0%,transparent 58%),radial-gradient(58% 55% at 50% 128%,#e7eeff 0%,transparent 62%),#fbfbfc",
        }}
      >
        <div style={grainStyle(0.05)} />
        <div style={{ position: "relative", zIndex: 2, maxWidth: 780, margin: "0 auto" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 13,
              fontWeight: 600,
              color: "#3182f6",
              background: "rgba(255,255,255,.72)",
              border: "1px solid #d6e4ff",
              padding: "7px 14px",
              borderRadius: 999,
              boxShadow: "0 1px 2px rgba(20,23,26,.04)",
              backdropFilter: "blur(6px)",
              marginBottom: 26,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#03b26c",
                boxShadow: "0 0 0 3px rgba(3,178,108,.18)",
              }}
            />
            지금 신청 가능한 지원사업 {activeCount}건
          </div>

          <h1
            style={{
              fontSize: "clamp(32px,5.4vw,56px)",
              lineHeight: 1.16,
              fontWeight: 800,
              letterSpacing: "-.04em",
              color: "#191f28",
              marginBottom: 20,
            }}
          >
            사업자번호만 넣으면,
            <br />
            <span
              style={{
                background: GRAD_TEXT,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              받을 수 있는 지원사업
            </span>
            이 보여요
          </h1>

          <p
            style={{
              fontSize: "clamp(16px,2.1vw,19px)",
              color: "#8b95a1",
              maxWidth: 560,
              margin: "0 auto 40px",
              lineHeight: 1.6,
            }}
          >
            복잡한 공고를 뒤질 필요 없어요. 사업자번호 하나로 우리 회사에 맞는 지원사업을 찾아 매칭하고, 신청 준비까지
            도와드려요.
          </p>

          <form onSubmit={submitBiz} style={{ position: "relative", maxWidth: 580, margin: "0 auto" }}>
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: "-30px -10px",
                background: "radial-gradient(closest-side,rgba(49,130,246,.22),transparent 75%)",
                filter: "blur(8px)",
                zIndex: 0,
              }}
            />
            <div
              style={{
                position: "relative",
                zIndex: 2,
                display: "flex",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
                background: "#fff",
                border: "1px solid #e5e8eb",
                borderRadius: 20,
                padding: "10px 10px 10px 22px",
                boxShadow: "0 12px 32px rgba(20,23,26,.1),0 4px 8px rgba(20,23,26,.05)",
              }}
            >
              <div
                style={{
                  flex: 1,
                  minWidth: 180,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  textAlign: "left",
                  padding: "4px 0",
                }}
              >
                <label style={{ fontSize: 11.5, fontWeight: 600, color: "#8b95a1" }}>사업자등록번호</label>
                <input
                  ref={heroBizInputRef}
                  inputMode="numeric"
                  maxLength={12}
                  placeholder="000-00-00000"
                  value={biz}
                  onChange={(e) => onBizInput(e.target.value)}
                  style={{
                    border: "none",
                    outline: "none",
                    fontFamily: "inherit",
                    fontSize: 19,
                    fontWeight: 700,
                    letterSpacing: ".02em",
                    color: "#191f28",
                    background: "transparent",
                    width: "100%",
                    padding: "1px 0",
                  }}
                />
              </div>
              <button type="submit" style={heroCtaStyle}>지원사업 찾기</button>
            </div>
            <LandingLookupSuggestions
              currentBizNo={onlyDigits(biz)}
              suggestions={visibleLookupSuggestions}
              onSelect={selectLookupSuggestion}
            />
          </form>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 18,
              flexWrap: "wrap",
              marginTop: 22,
              fontSize: 13,
              color: "#8b95a1",
            }}
          >
            <span style={trustItem}><span style={{ color: "#03b26c" }}>●</span> 회원가입 없이 바로 조회</span>
            <span style={trustItem}>🔒 입력 정보는 안전하게 암호화돼요</span>
            <span style={trustItem}><span style={{ color: "#03b26c" }}>●</span> 30초면 끝</span>
          </div>
        </div>
      </header>

      {/* ============ SOURCES ============ */}
      <section
        style={{
          borderTop: "1px solid #ecf0f3",
          borderBottom: "1px solid #ecf0f3",
          background: "#fff",
          padding: "28px clamp(20px,5vw,40px)",
        }}
      >
        <div style={{ maxWidth: 1120, margin: "0 auto", textAlign: "center" }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "#a8b0ba",
              letterSpacing: ".02em",
              marginBottom: 16,
            }}
          >
            매주 40여 개 기관의 공고를 수집해 표준화해요
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 10 }}>
            {["중소벤처기업부", "소상공인시장진흥공단", "창업진흥원", "KOTRA", "한국콘텐츠진흥원", "중소벤처기업진흥공단"].map(
              (org) => (
                <span
                  key={org}
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#6b7682",
                    background: "#f7f8fa",
                    border: "1px solid #eef0f3",
                    padding: "9px 16px",
                    borderRadius: 999,
                  }}
                >
                  {org}
                </span>
              ),
            )}
          </div>
        </div>
      </section>

      {/* ============ PROBLEM ============ */}
      <section
        style={{
          maxWidth: 1120,
          margin: "0 auto",
          padding: "clamp(64px,8vw,100px) clamp(20px,5vw,40px) clamp(40px,5vw,56px)",
          textAlign: "center",
        }}
      >
        <div style={eyebrow}>왜 창업노트인가요</div>
        <h2
          style={{
            fontSize: "clamp(26px,3.6vw,38px)",
            fontWeight: 800,
            letterSpacing: "-.035em",
            color: "#191f28",
            lineHeight: 1.28,
            maxWidth: 680,
            margin: "0 auto 18px",
          }}
        >
          지원사업은 어렵지 않아요.
          <br />
          그동안 정리가 안 됐을 뿐이에요
        </h2>
        <p
          style={{
            fontSize: "clamp(15px,1.9vw,17px)",
            color: "#8b95a1",
            maxWidth: 560,
            margin: "0 auto",
            lineHeight: 1.65,
          }}
        >
          공고는 기관마다 양식이 달라요. 우리는 흩어진 공고를 한 형식으로 표준화하고, 우리 회사에 맞는 것만 골라
          보여드려요.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))",
            gap: 16,
            marginTop: 48,
            textAlign: "left",
          }}
        >
          <ProblemCard emoji="🔍" iconBg="#fff3e0" title="공고 찾기에 지치는 일" body="수십 개 사이트를 돌며 우리에게 맞는 공고를 직접 골라야 했어요." />
          <ProblemCard emoji="📄" iconBg="#fde9ec" title="자격요건 해석의 벽" body="읽어도 우리가 지원 대상인지 확신이 안 서서 신청을 포기했어요." />
          <ProblemCard emoji="⏰" iconBg="#e6fbf1" title="놓쳐버린 마감" body="자격이 되는데도 마감일을 몰라 그냥 흘려보낸 지원금이 많았어요." />
        </div>
      </section>

      {/* ============ HOW ============ */}
      <section id="how" style={{ background: "#fff", borderTop: "1px solid #ecf0f3", borderBottom: "1px solid #ecf0f3" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", padding: "clamp(64px,8vw,100px) clamp(20px,5vw,40px)" }}>
          <div style={{ textAlign: "center", marginBottom: 52 }}>
            <div style={eyebrow}>작동 방식</div>
            <h2 style={{ fontSize: "clamp(26px,3.6vw,38px)", fontWeight: 800, letterSpacing: "-.035em", color: "#191f28", marginBottom: 12 }}>
              공부 없이, 세 단계면 충분해요
            </h2>
            <p style={{ fontSize: "clamp(15px,1.9vw,17px)", color: "#8b95a1" }}>입력부터 신청 준비까지 평균 30초.</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 20 }}>
            <StepCard n={1} title="사업자번호 입력" body="번호 하나만 넣으면 사업자 정보를 자동으로 불러와요. 따로 작성할 게 없어요." />
            <StepCard n={2} title="맞춤 매칭" body="표준화된 지원사업과 우리 회사를 대조해 지원 가능한 사업만 적합도 순으로 보여줘요." />
            <StepCard n={3} title="신청 코칭" body="필요한 서류와 데이터를 회사에 맞춰 채워주고, 빠진 것만 알려드려요." />
          </div>
        </div>
      </section>

      {/* ============ FEATURES ============ */}
      <section id="features" style={{ maxWidth: 1120, margin: "0 auto", padding: "clamp(64px,8vw,100px) clamp(20px,5vw,40px)" }}>
        <div style={{ textAlign: "center", marginBottom: 60 }}>
          <div style={eyebrow}>핵심 기능</div>
          <h2 style={{ fontSize: "clamp(26px,3.6vw,38px)", fontWeight: 800, letterSpacing: "-.035em", color: "#191f28" }}>
            찾고, 판단하고, 준비하는 일을 대신해요
          </h2>
        </div>

        <div style={featureRow(true)}>
          <div>
            <div style={featureTag}>표준화 매칭 엔진</div>
            <h3 style={featureTitle}>지원 가능한 사업만<br />적합도 순으로</h3>
            <p style={featureBody}>업종·업력·지역·매출을 공고의 자격요건과 대조해, 받을 수 있는 사업만 점수와 함께 정렬해요. 안 되는 공고를 읽느라 시간 쓸 필요가 없어요.</p>
            <Bullets items={["자격요건 자동 대조로 적합도 점수화", "지원금 규모·마감일까지 한눈에"]} />
          </div>
          <MatchingMock />
        </div>

        <div style={featureRow(true)}>
          <ChecklistMock />
          <div>
            <div style={featureTag}>회사 맞춤 신청 코칭</div>
            <h3 style={featureTitle}>서류의 80%는<br />이미 채워져 있어요</h3>
            <p style={featureBody}>회사 정보로 채울 수 있는 건 우리가 미리 채워두고, 진짜 직접 준비해야 할 것만 콕 집어 알려드려요. 무엇을 더 해야 하는지 한눈에 보여요.</p>
            <Bullets items={["사업계획서 초안 자동 생성", "부족한 서류만 콕 집어 안내"]} />
          </div>
        </div>

        <div style={featureRow(false)}>
          <div>
            <div style={featureTag}>마감 알림</div>
            <h3 style={featureTitle}>받을 수 있는 돈을<br />마감으로 놓치지 않게</h3>
            <p style={featureBody}>자격이 되는 공고의 마감이 다가오면 미리 알려드려요. 새로 열린 맞춤 공고도 매주 자동으로 챙겨요.</p>
            <Bullets items={["마감 임박 D-day 알림", "신규 맞춤 공고 주간 요약"]} />
          </div>
          <AlertsMock />
        </div>
      </section>

      {/* ============ NUMBERS ============ */}
      <section style={{ background: "#fff", borderTop: "1px solid #ecf0f3", borderBottom: "1px solid #ecf0f3" }}>
        <div
          style={{
            maxWidth: 1120,
            margin: "0 auto",
            padding: "clamp(48px,6vw,72px) clamp(20px,5vw,40px)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
            gap: 24,
            textAlign: "center",
          }}
        >
          <NumberStat value={activeCount} unit="건" label="지금 신청 가능한 지원사업" />
          <NumberStat value="40" unit="여 기관" label="매주 수집·표준화하는 공고 출처" />
          <NumberStat value="30" unit="초" label="사업자번호 입력부터 결과까지" />
        </div>
      </section>

      {/* ============ CTA ============ */}
      <section
        id="cta"
        style={{
          position: "relative",
          overflow: "hidden",
          padding: "clamp(64px,8vw,96px) clamp(20px,5vw,40px)",
          color: "#fff",
          background:
            "radial-gradient(55% 60% at 16% 14%,#4f8bff 0%,transparent 60%),radial-gradient(50% 55% at 90% 20%,#2bd4a8 0%,transparent 56%),radial-gradient(80% 70% at 50% 116%,#3182f6 0%,transparent 62%),linear-gradient(160deg,#1f4fc4 0%,#11307e 100%)",
        }}
      >
        <div style={grainStyle(0.06)} />
        <div style={{ position: "relative", zIndex: 2, maxWidth: 680, margin: "0 auto", textAlign: "center" }}>
          <h2 style={{ fontSize: "clamp(26px,3.8vw,40px)", fontWeight: 800, letterSpacing: "-.035em", lineHeight: 1.25, marginBottom: 16 }}>
            사업자번호 하나로
            <br />
            지금 바로 시작하세요
          </h2>
          <p style={{ fontSize: "clamp(15px,1.9vw,17.5px)", color: "rgba(255,255,255,.78)", lineHeight: 1.6, marginBottom: 34 }}>
            회원가입 없이 30초면 받을 수 있는 지원사업을 확인할 수 있어요.
          </p>
          <form onSubmit={submitBiz} style={{ position: "relative", maxWidth: 520, margin: "0 auto" }}>
            <div
              style={{
                position: "relative",
                zIndex: 2,
                display: "flex",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
                background: "#fff",
                borderRadius: 18,
                padding: "9px 9px 9px 20px",
                boxShadow: "0 18px 40px rgba(8,20,60,.4)",
              }}
            >
              <input
                inputMode="numeric"
                maxLength={12}
                placeholder="000-00-00000"
                value={biz}
                onChange={(e) => onBizInput(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 160,
                  border: "none",
                  outline: "none",
                  fontFamily: "inherit",
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: ".02em",
                  color: "#191f28",
                  background: "transparent",
                  padding: "6px 0",
                }}
              />
              <button
                type="submit"
                style={{
                  flex: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 50,
                  padding: "0 24px",
                  cursor: "pointer",
                  borderRadius: 13,
                  color: "#fff",
                  fontFamily: "inherit",
                  fontSize: 15.5,
                  fontWeight: 700,
                  border: "none",
                  background: GRAD_BTN,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,.3),0 6px 16px rgba(8,20,60,.3)",
                }}
              >
                지원사업 찾기
              </button>
            </div>
            <LandingLookupSuggestions
              currentBizNo={onlyDigits(biz)}
              suggestions={visibleLookupSuggestions}
              tone="dark"
              onSelect={selectLookupSuggestion}
            />
          </form>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 18,
              flexWrap: "wrap",
              marginTop: 20,
              fontSize: 13,
              color: "rgba(255,255,255,.7)",
            }}
          >
            <span>🔒 안전하게 암호화</span>
            <span>회원가입 불필요</span>
          </div>
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <section id="faq" style={{ maxWidth: 760, margin: "0 auto", padding: "clamp(64px,8vw,100px) clamp(20px,5vw,40px)" }}>
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <div style={eyebrow}>자주 묻는 질문</div>
          <h2 style={{ fontSize: "clamp(26px,3.6vw,36px)", fontWeight: 800, letterSpacing: "-.035em", color: "#191f28" }}>
            궁금한 점이 있으세요?
          </h2>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {FAQS.map((f, i) => {
            const open = i === faq;
            return (
              <div
                key={f.q}
                onClick={() => setFaq((cur) => (cur === i ? -1 : i))}
                style={{
                  background: "#fff",
                  border: "1px solid #ecf0f3",
                  borderRadius: 18,
                  padding: "20px 22px",
                  boxShadow: "0 1px 2px rgba(20,23,26,.04)",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#191f28", letterSpacing: "-.02em" }}>{f.q}</div>
                  <span style={{ flex: "none", fontSize: 20, lineHeight: 1, color: open ? "#3182f6" : "#c4ccd4" }}>
                    {open ? "−" : "+"}
                  </span>
                </div>
                {open ? (
                  <p style={{ fontSize: 14.5, color: "#8b95a1", lineHeight: 1.65, marginTop: 14 }}>{f.a}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* ============ FOOTER ============ */}
      <footer style={{ background: "#fff", borderTop: "1px solid #ecf0f3", padding: "clamp(40px,5vw,56px) clamp(20px,5vw,40px) 36px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 28, justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ maxWidth: 300 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 700, fontSize: 16, color: "#191f28", marginBottom: 12 }}>
              <BrandMark size={22} />
              <span style={{ fontWeight: 800 }}>창업노트</span>
            </div>
            <p style={{ fontSize: 13.5, color: "#8b95a1", lineHeight: 1.6 }}>사업자번호 하나로 받을 수 있는 지원사업을 찾고 신청까지 코칭해요.</p>
          </div>
          <div style={{ display: "flex", gap: "clamp(32px,6vw,72px)", flexWrap: "wrap" }}>
            <FooterCol title="제품" links={[["지원사업 찾기", "/"], ["신청 코칭", "/dashboard"], ["마감 알림", "/dashboard"]]} />
            <FooterCol title="회사" links={[["도입 문의", "/support"], ["개인정보처리방침", "/privacy"], ["이용약관", "/terms"]]} />
          </div>
        </div>
        <div style={{ maxWidth: 1120, margin: "28px auto 0", paddingTop: 22, borderTop: "1px solid #f2f4f6", fontSize: 13, color: "#a8b0ba" }}>
          © 2026 바톤 (Baton)
        </div>
      </footer>

      {lookup ? (
        <BizLookupModal
          lookup={lookup}
          onConfirm={confirmLookup}
          onReject={() => dismissLookup("rejected")}
          onClose={() => dismissLookup("closed")}
        />
      ) : null}
    </main>
  );

  async function createCompanyAndOpenDashboard(requestBody: TeaserRequest, resumeGrant?: string | null) {
    try {
      const response = await fetch("/api/web/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = (await response.json()) as { ok?: boolean; data?: { currentCompanyId?: string }; error?: { code?: string } };
      if (response.status === 401 && payload.error?.code === "auth_required") {
        redirectToLoginForDashboard();
        return;
      }
      if (response.ok && payload.ok && payload.data?.currentCompanyId) {
        window.location.assign(resumeGrant ? `/grants/${encodeURIComponent(resumeGrant)}` : "/dashboard");
      }
    } catch {
      /* noop — 사용자는 입력으로 재시도 */
    }
  }
}

/* ───────────────────────── sub components ───────────────────────── */

function BizLookupModal({
  lookup,
  onConfirm,
  onReject,
  onClose,
}: {
  lookup: BizLookupModalState;
  onConfirm: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [lookup.phase]);

  const maskedBizNo = lookup.phase === "confirm"
    ? lookup.preview.maskedBizNo
    : maskLandingBizNo(lookup.bizNo);
  const suspended = lookup.phase === "confirm" && lookup.preview.businessStatus?.active === false;
  const statusLabel = lookup.phase === "confirm"
    ? lookup.preview.businessStatus?.label ?? (suspended ? "휴업" : "영업 중")
    : null;

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(25,31,40,.46)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lp-lookup-title"
        style={{
          width: "100%",
          maxWidth: 420,
          background: "#fff",
          borderRadius: 24,
          padding: "30px 28px 26px",
          boxShadow: "0 24px 64px rgba(20,23,26,.24),0 8px 20px rgba(20,23,26,.12)",
          textAlign: "center",
        }}
      >
        {lookup.phase === "loading" ? (
          <>
            <ModalSpinner />
            <h3 id="lp-lookup-title" ref={headingRef} tabIndex={-1} style={modalTitle}>
              사업자 정보를 확인하고 있어요
            </h3>
            <p style={modalBody}>{maskedBizNo} 기준으로 상호와 영업상태를 확인 중이에요.</p>
          </>
        ) : null}

        {lookup.phase === "confirm" ? (
          <>
            <div style={modalEmoji("#e8f3ff")}>🏢</div>
            <h3 id="lp-lookup-title" ref={headingRef} tabIndex={-1} style={modalTitle}>
              『{lookup.preview.name ?? "상호명 미확인"}』<br />회사가 맞으신가요?
            </h3>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <span style={modalChip("#f2f4f6", "#4e5968")}>{maskedBizNo}</span>
              {statusLabel ? (
                <span style={modalChip(suspended ? "#fff3e0" : "#e6fbf1", suspended ? "#c77700" : "#03863f")}>
                  {statusLabel}
                </span>
              ) : null}
              {lookup.preview.regionLabel ? (
                <span style={modalChip("#f2f4f6", "#4e5968")}>{lookup.preview.regionLabel}</span>
              ) : null}
            </div>
            {suspended ? (
              <p style={{ ...modalBody, color: "#c77700" }}>
                국세청 기준 {statusLabel} 상태예요. 그래도 매칭 결과는 확인할 수 있어요.
              </p>
            ) : null}
            {lookup.preview.name === null ? (
              <p style={modalBody}>상호명을 확인하지 못했어요. 번호가 맞다면 그대로 진행할 수 있어요.</p>
            ) : null}
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 18 }}>
              <button type="button" onClick={onConfirm} style={modalPrimaryBtn}>
                네, 매칭 결과 보기
              </button>
              <button type="button" onClick={onReject} style={modalSecondaryBtn}>
                아니요, 다시 입력할게요
              </button>
            </div>
          </>
        ) : null}

        {lookup.phase === "error" ? (
          <>
            <div style={modalEmoji("#fde9ec")}>⚠️</div>
            <h3 id="lp-lookup-title" ref={headingRef} tabIndex={-1} style={modalTitle}>
              {lookup.title}
            </h3>
            <p style={modalBody}>{lookup.message}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 18 }}>
              <button type="button" onClick={onClose} style={modalPrimaryBtn}>
                사업자번호 다시 입력
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ModalSpinner() {
  return (
    <svg viewBox="0 0 44 44" width={44} height={44} style={{ display: "block", margin: "0 auto 16px" }} aria-hidden>
      <circle cx="22" cy="22" r="18" fill="none" stroke="#e8f3ff" strokeWidth="5" />
      <path d="M22 4 a18 18 0 0 1 18 18" fill="none" stroke="#3182f6" strokeWidth="5" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="0.9s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function LandingLookupSuggestions({
  suggestions,
  currentBizNo,
  tone = "light",
  onSelect,
}: {
  suggestions: BusinessLookupSuggestion[];
  currentBizNo: string;
  tone?: "light" | "dark";
  onSelect: (suggestion: BusinessLookupSuggestion) => void;
}) {
  if (suggestions.length === 0) return null;
  const dark = tone === "dark";

  return (
    <div
      role="listbox"
      aria-label="최근 조회한 사업자"
      style={{
        position: "relative",
        zIndex: 2,
        display: "grid",
        gap: 8,
        marginTop: 12,
        textAlign: "left",
      }}
    >
      {suggestions.map((suggestion) => {
        const selected = suggestion.bizNo === currentBizNo;
        return (
          <button
            key={`${suggestion.source}:${suggestion.bizNo}`}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(suggestion)}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,.9fr) minmax(0,1.1fr) auto",
              alignItems: "center",
              gap: 12,
              width: "100%",
              minHeight: 62,
              border: selected ? "1px solid #3182f6" : `1px solid ${dark ? "rgba(255,255,255,.24)" : "#e5e8eb"}`,
              borderRadius: 16,
              background: dark ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.92)",
              color: dark ? "#fff" : "#191f28",
              cursor: "pointer",
              fontFamily: "inherit",
              padding: "11px 13px",
              boxShadow: dark ? "none" : "0 4px 12px rgba(20,23,26,.06)",
              textAlign: "left",
            }}
          >
            <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
              <strong style={{ overflow: "hidden", fontSize: 13.5, fontWeight: 800, lineHeight: 1.25, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {suggestion.companyName ?? "상호 미확인"}
              </strong>
              <span style={{ color: dark ? "rgba(255,255,255,.74)" : "#6b7682", fontSize: 12, fontWeight: 700, lineHeight: 1.25 }}>
                {suggestion.bizNoFormatted}
              </span>
            </span>
            <span style={{ display: "grid", gap: 2, minWidth: 0, color: dark ? "rgba(255,255,255,.72)" : "#6b7682", fontSize: 12, fontWeight: 650, lineHeight: 1.35 }}>
              <span style={ellipsisText}>업종 {suggestion.industry ?? "미확인"}</span>
              <span style={ellipsisText}>업태 {suggestion.businessType ?? "미확인"}</span>
            </span>
            <span
              style={{
                border: `1px solid ${dark ? "rgba(255,255,255,.22)" : "#e5e8eb"}`,
                borderRadius: 999,
                color: dark ? "rgba(255,255,255,.82)" : "#4e5968",
                fontSize: 11,
                fontWeight: 800,
                padding: "5px 8px",
                marginLeft: "auto",
                whiteSpace: "nowrap",
                justifySelf: "end",
              }}
            >
              {suggestion.source === "account" ? "내 계정" : "이 브라우저"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ProblemCard({ emoji, iconBg, title, body }: { emoji: string; iconBg: string; title: string; body: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #ecf0f3", borderRadius: 24, padding: "28px 26px", boxShadow: "0 1px 2px rgba(20,23,26,.04)" }}>
      <div style={{ width: 44, height: 44, borderRadius: 13, background: iconBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, marginBottom: 18 }}>
        {emoji}
      </div>
      <h3 style={{ fontSize: 17.5, fontWeight: 700, letterSpacing: "-.02em", color: "#191f28", marginBottom: 8 }}>{title}</h3>
      <p style={{ fontSize: 14.5, color: "#8b95a1", lineHeight: 1.6 }}>{body}</p>
    </div>
  );
}

function StepCard({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div style={{ position: "relative", background: "#fbfbfc", border: "1px solid #ecf0f3", borderRadius: 24, padding: "30px 28px" }}>
      <div style={{ width: 40, height: 40, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16, color: "#3182f6", background: "#e8f3ff", marginBottom: 20 }}>
        {n}
      </div>
      <h3 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.02em", color: "#191f28", marginBottom: 8 }}>{title}</h3>
      <p style={{ fontSize: 14.5, color: "#8b95a1", lineHeight: 1.6 }}>{body}</p>
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map((it) => (
        <div key={it} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14.5, color: "#4e5968" }}>
          <span style={{ width: 20, height: 20, borderRadius: "50%", background: "#e6fbf1", color: "#03b26c", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>✓</span>
          {it}
        </div>
      ))}
    </div>
  );
}

function MatchingMock() {
  const rows = [
    { name: "청년창업사관학교 13기", meta: "최대 1억원 · 사업화 자금", dday: "D-5", warn: true, w: "96%", score: "96%" },
    { name: "소상공인 정책자금 융자", meta: "최대 7,000만원 · 운전·시설", dday: "D-21", warn: false, w: "92%", score: "92%" },
  ];
  return (
    <div style={{ background: "#fff", border: "1px solid #ecf0f3", borderRadius: 24, padding: 20, boxShadow: "0 12px 32px rgba(20,23,26,.08),0 4px 8px rgba(20,23,26,.04)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "#191f28" }}>매칭 결과 · 12건</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: "#3182f6", background: "#e8f3ff", padding: "5px 10px", borderRadius: 999 }}>적합도순</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map((r) => (
          <div key={r.name} style={{ border: "1px solid #ecf0f3", borderRadius: 16, padding: 15 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: "#191f28" }}>{r.name}</div>
                <div style={{ fontSize: 12, color: "#8b95a1", marginTop: 3 }}>{r.meta}</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: r.warn ? "#f5a623" : "#8b95a1", background: r.warn ? "#fff3e0" : "#f2f4f6", padding: "4px 8px", borderRadius: 8 }}>{r.dday}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
              <div style={{ flex: 1, height: 6, borderRadius: 99, background: "#f2f4f6", overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: r.w, background: GRAD_BAR }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#3182f6" }}>{r.score}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChecklistMock() {
  return (
    <div style={{ background: "#fff", border: "1px solid #ecf0f3", borderRadius: 24, padding: 22, boxShadow: "0 12px 32px rgba(20,23,26,.08),0 4px 8px rgba(20,23,26,.04)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, height: 8, borderRadius: 99, background: "#f2f4f6", overflow: "hidden" }}>
          <span style={{ display: "block", height: "100%", width: "80%", background: GRAD_BAR }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#3182f6" }}>80%</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {[
          ["사업자등록증", "자동으로 채웠어요"],
          ["최근 3개년 매출 증빙", "국세청 연동으로 자동 채움"],
        ].map(([t, n]) => (
          <div key={t} style={{ display: "flex", alignItems: "center", gap: 11, border: "1px solid #ecf0f3", borderRadius: 14, padding: "12px 14px" }}>
            <span style={{ flex: "none", width: 22, height: 22, borderRadius: "50%", background: "linear-gradient(150deg,#2bd4a8,#03b26c)", color: "#fff", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>✓</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#191f28" }}>{t}</div>
              <div style={{ fontSize: 11.5, color: "#8b95a1" }}>{n}</div>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 11, border: "1px solid #d6e4ff", background: "#f8faff", borderRadius: 14, padding: "12px 14px" }}>
          <span style={{ flex: "none", width: 22, height: 22, borderRadius: "50%", border: "2px solid #b9cdf2", background: "#fff" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#191f28" }}>4대보험 가입자 명부</div>
            <div style={{ fontSize: 11.5, color: "#3182f6", fontWeight: 600 }}>직접 올릴 유일한 서류</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AlertsMock() {
  const alerts = [
    { emoji: "⏰", bg: "#fff3e0", title: "청년창업사관학교 13기 · D-5", body: "마감이 5일 남았어요. 신청 준비를 마무리하세요." },
    { emoji: "✨", bg: "#e6fbf1", title: "새로 맞는 공고 2건", body: "이번 주 우리 회사에 맞는 공고가 추가됐어요." },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {alerts.map((a) => (
        <div key={a.title} style={{ display: "flex", alignItems: "center", gap: 14, background: "#fff", border: "1px solid #ecf0f3", borderRadius: 18, padding: "16px 18px", boxShadow: "0 4px 12px rgba(20,23,26,.06),0 1px 3px rgba(20,23,26,.04)" }}>
          <div style={{ flex: "none", width: 42, height: 42, borderRadius: 13, background: a.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19 }}>{a.emoji}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#191f28" }}>{a.title}</div>
            <div style={{ fontSize: 12.5, color: "#8b95a1", marginTop: 2 }}>{a.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function NumberStat({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <div>
      <div style={{ fontSize: "clamp(30px,4vw,44px)", fontWeight: 800, letterSpacing: "-.04em", color: "#191f28", fontVariantNumeric: "tabular-nums" }}>
        {value}
        <span style={{ fontSize: ".5em", color: "#8b95a1", fontWeight: 700 }}>{unit}</span>
      </div>
      <div style={{ fontSize: 13.5, color: "#8b95a1", marginTop: 6 }}>{label}</div>
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#a8b0ba", marginBottom: 3 }}>{title}</div>
      {links.map(([label, href]) => (
        <Link key={label} className="lp-footlink" href={href}>{label}</Link>
      ))}
    </div>
  );
}

function BrandMark({ size }: { size: number }) {
  const id = `lpg${size}`;
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none" style={{ display: "block", flex: "none" }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3182f6" />
          <stop offset="1" stopColor="#2bd4a8" />
        </linearGradient>
      </defs>
      <rect x="5" y="5" width="38" height="38" rx="11" fill={`url(#${id})`} />
      <path d="M15.5 24.5 l5.5 5.5 l11.5 -13.5" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ───────────────────────── shared styles ───────────────────────── */

const eyebrow: CSSProperties = { fontSize: 13, fontWeight: 700, color: "#3182f6", letterSpacing: ".04em", marginBottom: 14 };
const trustItem: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6 };
const featureTag: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 700, color: "#3182f6", background: "#e8f3ff", padding: "6px 12px", borderRadius: 999, marginBottom: 18 };
const featureTitle: CSSProperties = { fontSize: "clamp(22px,2.8vw,28px)", fontWeight: 800, letterSpacing: "-.03em", color: "#191f28", lineHeight: 1.32, marginBottom: 14 };
const featureBody: CSSProperties = { fontSize: 15.5, color: "#8b95a1", lineHeight: 1.65, marginBottom: 20 };
const ellipsisText: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const modalTitle: CSSProperties = {
  fontSize: 19,
  fontWeight: 800,
  letterSpacing: "-.03em",
  color: "#191f28",
  lineHeight: 1.35,
  marginBottom: 10,
  outline: "none",
};

const modalBody: CSSProperties = { fontSize: 14, color: "#8b95a1", lineHeight: 1.6, margin: "0 0 4px" };

const modalPrimaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 48,
  padding: "0 22px",
  cursor: "pointer",
  borderRadius: 13,
  color: "#fff",
  fontFamily: "inherit",
  fontSize: 15,
  fontWeight: 700,
  border: "none",
  background: GRAD_BTN,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,.3),0 6px 16px rgba(49,130,246,.3)",
};

const modalSecondaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 46,
  padding: "0 22px",
  cursor: "pointer",
  borderRadius: 13,
  color: "#4e5968",
  fontFamily: "inherit",
  fontSize: 14.5,
  fontWeight: 600,
  border: "1px solid #e5e8eb",
  background: "#fff",
};

function modalEmoji(bg: string): CSSProperties {
  return {
    width: 52,
    height: 52,
    borderRadius: 16,
    background: bg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 24,
    margin: "0 auto 16px",
  };
}

function modalChip(bg: string, color: string): CSSProperties {
  return {
    fontSize: 12.5,
    fontWeight: 700,
    color,
    background: bg,
    padding: "6px 11px",
    borderRadius: 999,
    letterSpacing: ".01em",
  };
}

const heroCtaStyle: CSSProperties = {
  flex: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 52,
  padding: "0 26px",
  cursor: "pointer",
  borderRadius: 14,
  color: "#fff",
  fontFamily: "inherit",
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: "-.02em",
  whiteSpace: "nowrap",
  border: "none",
  background: GRAD_BTN,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,.3),0 8px 20px rgba(49,130,246,.34)",
};

function featureRow(spaced: boolean): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))",
    gap: "clamp(28px,4vw,64px)",
    alignItems: "center",
    marginBottom: spaced ? "clamp(48px,6vw,80px)" : undefined,
  };
}

function gradientPill(py: number, px: number): CSSProperties {
  return {
    fontSize: 14.5,
    fontWeight: 700,
    color: "#fff",
    padding: `${py}px ${px}px`,
    borderRadius: 999,
    background: GRAD_BTN,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,.25),0 4px 12px rgba(49,130,246,.28)",
  };
}

function grainStyle(opacity: number): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundImage: NOISE_BG,
    backgroundSize: "180px",
    mixBlendMode: "overlay",
    opacity,
  };
}

/* ───────────────────────── helpers ───────────────────────── */

function onlyDigits(v: string): string {
  return v.replace(/\D/g, "").slice(0, 10);
}

/** preview 에러 코드별 모달 제목. 번호 문제는 재확인 유도, 그 외에는 재시도 유도. */
function titleForPreviewError(code: string | undefined): string {
  if (code === "invalid_biz_no" || code === "biz_no_not_registered" || code === "biz_no_closed") {
    return "사업자번호를 다시 확인해 주세요";
  }
  return "잠시 후 다시 시도해 주세요";
}

/** 10자리 사업자번호를 000-**-***** 로 마스킹(서버 maskedBizNo와 동일 포맷). */
function maskLandingBizNo(digits: string): string {
  if (digits.length !== 10) return fmtBiz(digits);
  return `${digits.slice(0, 3)}-**-*****`;
}

function fmtBiz(v: string): string {
  const d = onlyDigits(v);
  if (d.length > 5) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  if (d.length > 3) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return d;
}

function filterLandingLookupSuggestions(
  suggestions: BusinessLookupSuggestion[],
  query: string,
): BusinessLookupSuggestion[] {
  const normalizedQuery = normalizeBusinessLookupBizNo(query);
  const filtered = normalizedQuery
    ? suggestions.filter((suggestion) => {
      if (suggestion.bizNo === normalizedQuery) return false;
      return suggestion.bizNo.startsWith(normalizedQuery) ||
        suggestion.bizNoFormatted.includes(normalizedQuery) ||
        suggestion.companyName?.includes(normalizedQuery);
    })
    : suggestions;
  return filtered.slice(0, 4);
}

function readPendingTeaserRequest(): TeaserRequest | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_TEASER_STORAGE_KEY);
    window.sessionStorage.removeItem(PENDING_TEASER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TeaserRequest) : null;
  } catch {
    return null;
  }
}

function redirectToLoginForDashboard() {
  const params = new URLSearchParams({ callbackUrl: "/?resumeCompany=1" });
  window.location.assign(`/login?${params.toString()}`);
}

function clearResumeFlag(params: URLSearchParams) {
  params.delete("resumeCompany");
  params.delete("resumeGrant");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
}
