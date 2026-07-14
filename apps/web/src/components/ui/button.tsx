import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[12px] border border-transparent bg-clip-padding text-sm font-bold whitespace-nowrap transition-all duration-200 outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary bg-grad-cta text-primary-foreground shadow-[var(--shadow-cta)] hover:bg-none hover:bg-brand-hover",
        outline:
          "border-input bg-background text-text-nav hover:bg-surface-soft aria-expanded:bg-surface-soft",
        secondary:
          "bg-surface-muted text-text-nav hover:bg-surface-muted-hover aria-expanded:bg-surface-muted",
        ghost:
          "font-semibold text-text-secondary hover:bg-surface-soft hover:text-text-nav aria-expanded:bg-surface-soft",
        "brand-soft":
          "bg-brand-tint text-brand-hover hover:bg-[color-mix(in_srgb,var(--brand-tint),var(--brand)_10%)] aria-expanded:bg-brand-tint",
        "brand-outline":
          "border-border-card-hover bg-background text-brand-hover hover:bg-surface-brand aria-expanded:bg-surface-brand",
        destructive:
          "bg-destructive text-white hover:bg-[color-mix(in_srgb,var(--destructive),#000_8%)] focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-12 gap-1.5 px-5 text-[15px] has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        xs: "h-6 gap-1 rounded-[9px] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 gap-1 rounded-[10px] px-3.5 text-[13.5px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-14 gap-1.5 rounded-[14px] px-6 text-[17px] has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5",
        icon: "size-10",
        "icon-xs": "size-6 rounded-[9px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-[10px]",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
