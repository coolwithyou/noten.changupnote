import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { REVIEW_WORKSPACE_ROLES, defaultAdminPath } from "@/lib/auth/routeAccess"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"

const VERDICTS = [
  ["정확", "이 criterion을 그대로 DB에 넣어도 원문과 다른 결론이 나오는 기업이 없습니다."],
  ["수정 필요", "요건은 원문에 있지만 값·연산자·kind·축이 달라 결론이 바뀔 수 있습니다."],
  ["오류", "요건 자체가 원문에 없거나 다른 문구를 자격요건으로 오독했습니다."],
  ["판단 불가", "원문이나 첨부만으로 확정할 수 없습니다. 편의상 선택하지 않습니다."],
] as const

export default async function ReviewGuidePage() {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  if (!REVIEW_WORKSPACE_ROLES.includes(session.user.role)) redirect(defaultAdminPath(session.user.role))

  return (
    <OpsDashboardShell
      title="검수 판정 가이드"
      user={{ email: session.user.email, name: session.user.name, role: session.user.role }}
    >
      <main className="flex max-w-5xl flex-col gap-6 p-4 md:p-6">
        <Alert>
          <AlertTitle>단 하나의 리트머스</AlertTitle>
          <AlertDescription>
            “이 criterion을 이대로 DB에 넣고 매칭 판정에 썼을 때, 원문과 다른 결론이 나오는 기업이 존재하는가?”
          </AlertDescription>
        </Alert>
        <section className="grid gap-4 md:grid-cols-2">
          {VERDICTS.map(([title, description]) => (
            <Card key={title}>
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {title === "정확" ? "표현이 축약돼도 판정 결과가 같다면 정확입니다." : "정확이 아니면 무엇이 틀렸고 올바른 값은 무엇인지 사유에 남깁니다."}
              </CardContent>
            </Card>
          ))}
        </section>
        <Card>
          <CardHeader>
            <CardTitle>항목당 30초 루틴</CardTitle>
            <CardDescription>원문이 기준이며 기존 DB 값은 참고일 뿐입니다.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="ml-5 flex list-decimal flex-col gap-2 text-sm">
              <li>근거 인용이 원문에 실제로 있는지 확인합니다.</li>
              <li>value의 수치·목록·플래그와 operator를 대조합니다.</li>
              <li>필수·우대·결격 kind가 원문 취지와 맞는지 봅니다.</li>
              <li>other 남용이나 잘못된 dimension 배정을 확인합니다.</li>
              <li>정확이 아니면 원문 근거와 올바른 수정 방향을 적습니다.</li>
            </ol>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>자주 흔들리는 경계</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="ml-5 flex list-disc flex-col gap-2 text-sm">
              <li>서류 미비·허위 기재 제재 같은 절차 조항의 요건화는 대개 “수정 필요”입니다.</li>
              <li>원문 수치를 text_only로 내린 경우 기계 판정을 잃으므로 “수정 필요”입니다.</li>
              <li>같은 취지의 중복 criterion은 하나만 정확, 나머지는 중복 사유의 “수정 필요”입니다.</li>
              <li>blind 표본에서는 AI 판정이 보이지 않는 것이 정상입니다. 원문만으로 독립 판정합니다.</li>
            </ul>
          </CardContent>
        </Card>
      </main>
    </OpsDashboardShell>
  )
}
