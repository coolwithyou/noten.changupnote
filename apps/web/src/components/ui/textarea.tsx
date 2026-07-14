import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-36 w-full resize-y rounded-[12px] border-[1.5px] border-input bg-background px-4 py-3 text-[15px] leading-6 text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-text-quaternary focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-ring/12 disabled:cursor-not-allowed disabled:bg-surface-soft disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
