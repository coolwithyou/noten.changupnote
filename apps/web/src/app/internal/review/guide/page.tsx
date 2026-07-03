import { notFound } from "next/navigation";
import Link from "next/link";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 검수팀 인앤 가이드 (/internal/review/guide).
 *
 * 콘텐츠 원천: docs/review-team-guide.md (0~6장).
 * 마크다운 파서를 추가하지 않기 위해 정적 JSX 로 옮겨 담았다.
 * ⚠️ 내용 동기화 주의: docs/review-team-guide.md 를 수정하면 이 파일도 함께 갱신할 것.
 *   (원문이 단일 원천 — 여기서는 화면 표현만 담당)
 */
export default async function ReviewGuidePage() {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 text-slate-900">
      <div className="mb-6">
        <Link href="/internal/review" className="text-sm text-indigo-600 hover:underline">
          ← 목록
        </Link>
        <h1 className="mt-2 text-2xl font-bold">검수팀 가이드 — 필드맵 라벨 검수</h1>
        <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          대상: 비개발자 리뷰어. 화면만 있으면 됩니다 (설치·코드 불필요). 이 가이드의 절차는 2026-07-03 실제
          검수 시뮬레이션(저장→확정→취소 왕복)으로 검증되었습니다.
        </p>
      </div>

      <div className="space-y-8 text-sm leading-relaxed text-slate-700">
        <Section title="0. 이 작업을 왜 하나요 — 그리고 무엇을 얻나요">
          <p>
            창업노트는 공고 첨부서류(HWP/PDF)에서 &quot;지원자가 채워야 할 칸&quot;(필드)을 자동으로 찾아내는
            시스템을 만들고 있습니다. AI가 45개 서류에서 1,579개 필드를 미리 찾아놨지만,{" "}
            <strong>AI가 스스로 만든 답을 AI 채점 기준으로 쓸 수는 없습니다.</strong> 사람이 확정한
            정답지(golden set)가 있어야 비로소:
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <strong>측정이 가능해집니다</strong> — 여러 자동 추출 엔진 후보를 &quot;정답 대비 몇 %를
              찾았나&quot;로 숫자 비교해 선택할 수 있습니다 (커버리지 80% 이상이 통과 기준)
            </li>
            <li>
              <strong>안전장치가 검증됩니다</strong> — 서명·동의·직인처럼 반드시 사람이 직접 써야 하는
              항목을 시스템이 99% 이상 잡아내는지 확인합니다. 이게 뚫리면 사용자가 접수 거절을 당합니다
            </li>
            <li>
              <strong>시스템이 계속 배웁니다</strong> — 여러분의 확정 하나하나가 일회성 검사가 아니라
              시스템이 앞으로 모든 서류를 더 정확히 읽게 만드는 영구 자산으로 쌓입니다
            </li>
          </ol>
          <p>
            여러분이 확정 버튼을 누르는 순간 그 문서는 &quot;정답&quot;으로 승격되고, 시스템 채점에 바로
            쓰입니다. <strong>45개 문서 검수가 끝나야 다음 개발 단계가 시작됩니다</strong> — 지금 이 작업이
            전체 일정의 관문입니다.
          </p>
        </Section>

        <Section title="1. 접속">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <code>dev.changupnote.com</code> 에서 <strong>구글 로그인</strong> (등록된 이메일이어야 합니다 —
              안 되면 관리자에게 이메일 등록 요청)
            </li>
            <li>
              주소창에 <code>dev.changupnote.com/internal/review</code> 입력
            </li>
            <li>
              문서 45건 목록이 보이면 준비 완료. (&quot;페이지를 찾을 수 없음&quot;이 뜨면 등록되지 않은
              계정입니다)
            </li>
          </ol>
        </Section>

        <Section title="2. 화면 구성">
          <p>
            <strong>목록 화면</strong>: 문서별 상태(대기/검수 중/확정)·필드 수·진행률.{" "}
            <strong>교정 노트 뱃지</strong>가 붙은 문서는 미리 알려진 주의사항이 있는 문서입니다 (10건).
          </p>
          <p className="font-semibold">검수 화면 (문서 클릭):</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              왼쪽: 서류 페이지 이미지. 필드를 클릭하면 해당 위치에 <strong>빨간 상자(bbox)</strong> 강조.
              반대로 이미지의 상자를 클릭하면 해당 필드로 이동합니다
            </li>
            <li>
              오른쪽: 필드 목록. 이름(key), 라벨, 종류, 필수 여부, manual 여부, 메모(notes) 수정 가능
            </li>
            <li>
              오른쪽 상단 <strong>&quot;확인 필요만&quot; 버튼</strong>: AI가 스스로 자신 없다고 표시한
              필드만 전 페이지에서 모아 봅니다. 필드를 클릭하면 해당 페이지로 자동 이동합니다
            </li>
            <li>
              <strong>필드 검색</strong>: key/label 부분일치로 목록을 좁힐 수 있습니다 (페이지·확인 필요
              필터와 함께 동작)
            </li>
            <li>상단: 미리 알려진 교정 노트(있는 경우) + 판정 기준서 안내</li>
          </ul>
        </Section>

        <Section title="3. 문서 1건 검수 절차 (10~20분)">
          <p>
            우선순위 순서대로 봅니다. <strong>누락 필드 찾기 &gt; 잘못된 분류 고치기 &gt; 상자 위치</strong>
            입니다.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <strong>&quot;확인 필요만&quot; 먼저</strong> — AI가 자신 없어 한 필드부터 판정하고 notes의
              &quot;확인 필요&quot; 문구를 지우거나 결론으로 바꿉니다
            </li>
            <li>
              <strong>누락 찾기</strong> — 페이지를 넘기며 &quot;지원자가 써야 하는데 목록에 없는 칸&quot;을
              찾아 [+ 필드 추가]. 특히 <strong>말미 서명행</strong>(신청인 ___ (인))은 자주 누락됩니다
            </li>
            <li>
              <strong>분류 확인</strong> — 아래 3개가 가장 중요합니다:
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>manual (자필·서명 필요)</strong>: 서명·직인·자필 동의 등 &quot;사람이 반드시
                  직접&quot; 항목이 manual=true인가 (생년월일 단독란은 manual 아님 / 주민번호 기입란은 manual
                  유지)
                </li>
                <li>
                  <strong>type</strong>: 체크박스인데 text로 되어 있지 않은가, 표(table)인데 낱개 필드로
                  쪼개져 있지 않은가
                </li>
                <li>
                  <strong>required (필수)</strong>: 별표·&quot;필수&quot; 표기가 있는 항목만 true인가
                </li>
              </ul>
            </li>
            <li>
              <strong>상자 위치</strong> — 크게 어긋난 것만 고치면 됩니다. 필드를 선택한 뒤{" "}
              <strong>[bbox 다시 그리기]</strong> 를 켜고 이미지 위에서 드래그하면 새 상자를 지정합니다
              (Esc로 취소). 미세 조정은 불필요 — 위치는 다음 단계에서 기계가 재계산합니다. 리뷰어는 &quot;어느
              칸인지 구분되는 수준&quot;까지만 교정하면 됩니다
            </li>
            <li>
              <strong>[저장]</strong> — 중간 저장. 상태가 &quot;검수 중&quot;으로 바뀝니다
            </li>
            <li>
              <strong>[검수 확정]</strong> — 이 문서를 정답으로 승격. <strong>실수해도 [확정 취소]로 되돌릴
              수 있습니다</strong>
            </li>
          </ol>
        </Section>

        <Section title="4. 판정이 헷갈릴 때">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              기준서(<code>docs/gate1-field-map-labeling-guide.md</code>)의 규칙 1~10과 표준 key 사전이
              원칙입니다. key를 새로 만들기 전에 사전에 같은 의미가 있는지 확인하세요 (기업명은 항상{" "}
              <code>company_name</code>)
            </li>
            <li>
              그래도 애매하면 필드의 <strong>[보류]</strong> 토글을 켜고 사유를 적은 뒤 저장만 하세요
              (확정하지 말 것). notes 앞에 <code>판정 보류: (이유)</code> 로 구조화됩니다. 운영자가 모아서
              기준서 &quot;판정 사례집&quot;에 결론을 등재한 뒤 알려드립니다
            </li>
            <li>
              원본 서류를 직접 열어봐야 하는 문서(doc28 등)는 교정 노트에 표시되어 있습니다 — 해당 건은
              운영자에게 원본 파일을 요청하세요. 문서별 <strong>리뷰어 코멘트</strong> 칸에 운영자에게 남길
              메모를 적을 수 있습니다
            </li>
          </ul>
        </Section>

        <Section title="5. 작업 순서 (권장)">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              교정 노트 뱃지가 있는 10건 중{" "}
              <strong>소급 교정 대상 (doc05, doc10, doc23, doc29)</strong> 먼저
            </li>
            <li>나머지는 목록 순서대로. 하루 4~6건이면 2주 내 완료됩니다</li>
            <li>같은 계열 문서(비슷한 양식)는 몰아서 하면 key 통일이 쉽습니다</li>
          </ol>
        </Section>

        <Section title="6. 하지 말아야 할 것">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>추측으로 확정하지 않기</strong> — 확정은 &quot;이 문서의 모든 필드에 책임진다&quot;는
              뜻입니다. 불확실하면 저장 + 판정 보류 메모
            </li>
            <li>이미지에 없는 내용을 상상으로 추가하지 않기 (원본 확인이 필요하면 요청)</li>
            <li>
              필드 삭제는 신중히 — &quot;중복이라서&quot;가 아니라면 삭제 대신 notes에 이유를 남기고 보류
            </li>
          </ul>
        </Section>
      </div>

      <div className="mt-10 border-t border-slate-200 pt-6">
        <Link
          href="/internal/review"
          className="inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          목록으로 돌아가기
        </Link>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-lg font-bold text-slate-900">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
