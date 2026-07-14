import { redirect } from "next/navigation";

/** 구 아카이브 화면은 통합 대시보드의 매칭 상태 탭으로 합쳐졌다. */
export default function ArchivePage() {
  redirect("/dashboard");
}
