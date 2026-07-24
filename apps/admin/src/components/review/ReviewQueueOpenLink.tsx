"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowRightIcon } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

export function ReviewQueueOpenLink({
  href,
  label,
}: {
  href: string
  label: string
}) {
  const [pending, setPending] = useState(false)

  return (
    <Link
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        pending && "pointer-events-none",
      )}
      href={href}
      aria-disabled={pending}
      onClick={(event) => {
        if (
          event.button !== 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) return
        setPending(true)
      }}
    >
      {pending ? (
        <>
          <Spinner data-icon="inline-start" />
          상세 불러오는 중
        </>
      ) : (
        <>
          {label}
          <ArrowRightIcon data-icon="inline-end" />
        </>
      )}
    </Link>
  )
}
