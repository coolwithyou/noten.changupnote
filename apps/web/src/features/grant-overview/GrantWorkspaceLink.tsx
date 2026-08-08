"use client";

import Link, { useLinkStatus } from "next/link";
import { Spinner } from "@/components/ui/spinner";

export function GrantWorkspaceLink({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
  className: string;
}) {
  return (
    <Link href={href} className={className}>
      <GrantWorkspaceLinkContent label={label} />
    </Link>
  );
}

function GrantWorkspaceLinkContent({ label }: { label: string }) {
  const { pending } = useLinkStatus();

  return (
    <>
      {pending ? (
        <Spinner
          data-icon="inline-start"
          role={undefined}
          aria-label={undefined}
          aria-hidden="true"
        />
      ) : null}
      <span aria-live="polite">{pending ? "지원서 작성 화면 여는 중" : label}</span>
    </>
  );
}
