import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface PreviewPageProps {
  params: Promise<{ grantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/grants/[grantId]/preview` → `/grants/[grantId]/workspace` 리다이렉트 (Apply Experience v2 · §12 결정 4 · P2-9).
 *
 * 기존 문서 뷰어(DocumentPreviewView)는 workspace 좌측 PreviewCanvas 로 통합됐다. 인증(requireCompanyAccess)은
 * 리다이렉트 대상인 workspace 페이지가 강제한다.
 *
 * 쿼리 파라미터 의미 보존: workspace 의 문서 선택은 `?document=`(draftableDocument.documentKey) 기준이다.
 *  - `?document=` 가 이미 있으면 그대로 전달한다.
 *  - 구 preview 의 `?surface=`(grant_application_surfaces.id)는 documentKey 와 식별자 체계가 달라
 *    리다이렉트 시점에 무손실 매핑이 불가능하다(surface↔document 매핑은 workspace 로더 로직 — 신규 서버
 *    함수 없이 재현 불가). workspace 로더의 기본 문서 선택이 "매칭 surface 에 페이지 이미지가 있는 문서"를
 *    우선하므로(§4.3), surface 파라미터 없이도 프리뷰가 있는 문서로 자연 진입한다.
 */
export default async function GrantDocumentPreviewPage({ params, searchParams }: PreviewPageProps) {
  const { grantId } = await params;
  const query = await searchParams;
  const documentKey = firstParam(query.document);
  const target = `/grants/${encodeURIComponent(grantId)}/workspace${
    documentKey ? `?document=${encodeURIComponent(documentKey)}` : ""
  }`;
  redirect(target);
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
