import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export default function PipelineLoading() {
  return (
    <main className="flex flex-col gap-6 p-4 md:p-6">
      <section className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </section>

      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="rounded-lg border p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-8 w-16" />
              <Skeleton className="mt-3 h-4 w-full" />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    </main>
  )
}
