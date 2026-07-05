import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { ReviewWorkspaceShell } from "@/features/review/ReviewWorkspaceShell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 검수팀 인앤 가이드 (/internal/review/guide).
 *
 * 콘텐츠 원천: docs/review-team-guide.md (0~6장).
 * 마크다운 파서를 추가하지 않기 위해 정적 JSX 로 옮겨 담았다.
 * 주의: docs/review-team-guide.md 를 수정하면 이 파일도 함께 갱신할 것.
 */
export default async function ReviewGuidePage() {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) notFound();

  return (
    <ReviewWorkspaceShell
      reviewerEmail={reviewer.email}
      currentPath="/internal/review/guide"
      title="검수팀 가이드"
      description="필드맵 라벨 검수 절차와 판정 기준입니다."
      badge="리뷰어 온보딩"
      actions={
        <Link href="/internal/review" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          <ArrowLeft data-icon="inline-start" />
          목록
        </Link>
      }
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <Alert>
          <AlertTitle>대상: 비개발자 리뷰어</AlertTitle>
          <AlertDescription>
            화면만 있으면 됩니다. 설치나 코드는 필요하지 않습니다. 이 절차는 2026-07-03 실제 검수 시뮬레이션으로
            검증되었습니다.
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-4 text-sm leading-6">
          <Section title="0. 이 작업을 왜 하나요 - 그리고 무엇을 얻나요">
            <p>
              창업노트는 공고 첨부서류(HWP/PDF)에서 &quot;지원자가 채워야 할 칸&quot;(필드)을 자동으로 찾아내는
              시스템을 만들고 있습니다. AI가 45개 서류에서 1,579개 필드를 미리 찾아놨지만,{" "}
              <strong>AI가 스스로 만든 답을 AI 채점 기준으로 쓸 수는 없습니다.</strong> 사람이 확정한 정답지(golden
              set)가 있어야 합니다.
            </p>
            <ol className="ml-5 flex list-decimal flex-col gap-1">
              <li>
                <strong>측정이 가능해집니다</strong> - 여러 자동 추출 엔진 후보를 &quot;정답 대비 몇 %를 찾았나&quot;로
                숫자 비교해 선택할 수 있습니다.
              </li>
              <li>
                <strong>안전장치가 검증됩니다</strong> - 서명·동의·직인처럼 반드시 사람이 직접 써야 하는 항목을
                시스템이 99% 이상 잡아내는지 확인합니다.
              </li>
              <li>
                <strong>시스템이 계속 배웁니다</strong> - 여러분의 확정 하나하나가 시스템이 앞으로 모든 서류를 더
                정확히 읽게 만드는 영구 자산으로 쌓입니다.
              </li>
            </ol>
            <p>
              여러분이 확정 버튼을 누르는 순간 그 문서는 &quot;정답&quot;으로 승격되고, 시스템 채점에 바로 쓰입니다.{" "}
              <strong>45개 문서 검수가 끝나야 다음 개발 단계가 시작됩니다.</strong>
            </p>
          </Section>

          <Section title="1. 접속">
            <ol className="ml-5 flex list-decimal flex-col gap-1">
              <li>
                <code>dev.changupnote.com</code> 에서 <strong>구글 로그인</strong>을 합니다. 등록된 이메일이어야
                합니다.
              </li>
              <li>
                주소창에 <code>dev.changupnote.com/internal/review</code> 를 입력합니다.
              </li>
              <li>문서 45건 목록이 보이면 준비 완료입니다. &quot;페이지를 찾을 수 없음&quot;이 뜨면 등록되지 않은 계정입니다.</li>
            </ol>
          </Section>

          <Section title="2. 화면 구성">
            <p>
              <strong>목록 화면</strong>: 문서별 상태(대기/검수중/확정), 필드 수, 진행률을 봅니다.{" "}
              <strong>교정 노트 뱃지</strong>가 붙은 문서는 미리 알려진 주의사항이 있는 문서입니다.
            </p>
            <p className="font-medium">검수 화면(문서 클릭):</p>
            <ul className="ml-5 flex list-disc flex-col gap-1">
              <li>왼쪽: 서류 페이지 이미지. 필드를 클릭하면 해당 위치에 상자(bbox)가 강조됩니다.</li>
              <li>오른쪽: 필드 목록. 이름(key), 라벨, 종류, 필수 여부, manual 여부, 메모를 수정할 수 있습니다.</li>
              <li>오른쪽 상단 &quot;확인 필요만&quot;: AI가 자신 없다고 표시한 필드만 전 페이지에서 모아 봅니다.</li>
              <li>필드 검색: key/label 부분일치로 목록을 좁힙니다.</li>
              <li>상단: 미리 알려진 교정 노트와 판정 기준서 안내를 봅니다.</li>
            </ul>
          </Section>

          <Section title="3. 문서 1건 검수 절차">
            <p>
              우선순위는 <strong>누락 필드 찾기 &gt; 잘못된 분류 고치기 &gt; 상자 위치</strong>입니다.
            </p>
            <ol className="ml-5 flex list-decimal flex-col gap-1">
              <li>&quot;확인 필요만&quot; 먼저 판정하고 notes의 &quot;확인 필요&quot; 문구를 결론으로 바꿉니다.</li>
              <li>페이지를 넘기며 지원자가 써야 하는데 목록에 없는 칸을 찾아 [+ 필드 추가]합니다.</li>
              <li>
                분류 확인에서는 <strong>manual</strong>, <strong>type</strong>, <strong>required</strong> 세 항목을
                가장 중요하게 봅니다.
              </li>
              <li>상자 위치는 크게 어긋난 것만 고칩니다. 미세 조정은 불필요합니다.</li>
              <li>[저장]으로 중간 저장합니다. 상태가 &quot;검수중&quot;으로 바뀝니다.</li>
              <li>[검수 확정]으로 정답 승격합니다. 실수해도 [확정 취소]로 되돌릴 수 있습니다.</li>
            </ol>
          </Section>

          <Section title="4. 판정이 헷갈릴 때">
            <ul className="ml-5 flex list-disc flex-col gap-1">
              <li>
                기준서(<code>docs/gate1-field-map-labeling-guide.md</code>)의 규칙 1~10과 표준 key 사전이 원칙입니다.
              </li>
              <li>
                그래도 애매하면 필드의 <strong>[보류]</strong> 토글을 켜고 사유를 적은 뒤 저장만 하세요.
              </li>
              <li>
                원본 서류를 직접 열어봐야 하는 문서는 문서별 <strong>리뷰어 코멘트</strong> 칸에 운영자에게 남길
                메모를 적습니다.
              </li>
            </ul>
          </Section>

          <Section title="5. 작업 순서">
            <ol className="ml-5 flex list-decimal flex-col gap-1">
              <li>
                교정 노트 뱃지가 있는 10건 중 <strong>소급 교정 대상(doc05, doc10, doc23, doc29)</strong>을 먼저 봅니다.
              </li>
              <li>나머지는 목록 순서대로 진행합니다. 하루 4~6건이면 2주 내 완료됩니다.</li>
              <li>같은 계열 문서는 몰아서 하면 key 통일이 쉽습니다.</li>
            </ol>
          </Section>

          <Section title="6. 하지 말아야 할 것">
            <ul className="ml-5 flex list-disc flex-col gap-1">
              <li>
                <strong>추측으로 확정하지 않기</strong> - 확정은 이 문서의 모든 필드에 책임진다는 뜻입니다.
              </li>
              <li>이미지에 없는 내용을 상상으로 추가하지 않기.</li>
              <li>필드 삭제는 신중히 하기. 삭제 대신 notes에 이유를 남기고 보류하는 편이 안전합니다.</li>
            </ul>
          </Section>
        </div>

        <Separator />

        <Link href="/internal/review" className={cn(buttonVariants(), "w-fit")}>
          목록으로 돌아가기
        </Link>
      </div>
    </ReviewWorkspaceShell>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 text-muted-foreground [&_strong]:text-foreground">{children}</div>
      </CardContent>
    </Card>
  );
}
