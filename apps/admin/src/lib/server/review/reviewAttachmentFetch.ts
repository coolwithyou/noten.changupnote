import { DispatchReviewError } from "./dispatchReview"

const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024
const FETCH_TIMEOUT_MS = 45_000

const TRUSTED_HOSTS: Record<string, ReadonlySet<string>> = {
  bizinfo: new Set(["www.bizinfo.go.kr"]),
  kstartup: new Set(["www.k-startup.go.kr"]),
}

export function isTrustedReviewAttachmentUrl(source: string, value: string): boolean {
  const hosts = TRUSTED_HOSTS[source]
  if (!hosts) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === "https:" || url.protocol === "http:")
      && !url.username
      && !url.password
      && !url.port
      && hosts.has(url.hostname.toLowerCase())
    )
  } catch {
    return false
  }
}

export async function fetchReviewAttachment(input: {
  source: string
  sourceUri: string
  expectedBytes: number | null
}): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  if (!isTrustedReviewAttachmentUrl(input.source, input.sourceUri)) {
    throw new DispatchReviewError(
      "review_attachment_source_forbidden",
      "허용된 공고 출처의 첨부만 열 수 있습니다.",
      403,
    )
  }
  if (input.expectedBytes != null && input.expectedBytes > MAX_ATTACHMENT_BYTES) {
    throw new DispatchReviewError(
      "review_attachment_too_large",
      "30MB 이하의 HWP/HWPX 첨부만 미리볼 수 있습니다.",
      413,
    )
  }

  const response = await fetch(input.sourceUri, {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "user-agent": "Cunote-Ops-Review/1.0",
    },
  })
  if (!response.ok) {
    throw new DispatchReviewError(
      "review_attachment_fetch_failed",
      `공고 출처에서 첨부를 불러오지 못했습니다. (${response.status})`,
      502,
    )
  }
  if (!isTrustedReviewAttachmentUrl(input.source, response.url)) {
    throw new DispatchReviewError(
      "review_attachment_redirect_forbidden",
      "첨부가 허용되지 않은 주소로 이동해 미리보기를 중단했습니다.",
      502,
    )
  }
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
    throw new DispatchReviewError(
      "review_attachment_too_large",
      "30MB 이하의 HWP/HWPX 첨부만 미리볼 수 있습니다.",
      413,
    )
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new DispatchReviewError(
      "review_attachment_too_large",
      "30MB 이하의 HWP/HWPX 첨부만 미리볼 수 있습니다.",
      413,
    )
  }
  return {
    bytes,
    contentType: response.headers.get("content-type"),
  }
}

export function attachmentContentDisposition(filename: string, download: boolean): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replaceAll('"', "")
  const encoded = encodeURIComponent(filename).replaceAll("'", "%27")
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
