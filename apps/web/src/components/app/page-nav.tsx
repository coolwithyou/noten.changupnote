import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PageNav({
  links,
  className,
  variant = "app",
}: {
  links: Array<{ href: string; label: string }>;
  className?: string;
  variant?: "landing" | "app";
}) {
  if (variant === "landing") {
    return (
      <nav className={cn("service-links", className)}>
        {links.map((link) => (
          <a
            key={`${link.href}:${link.label}`}
            className={buttonVariants({ variant: "outline", size: "sm", className: "nav-pill" })}
            href={link.href}
          >
            {link.label}
          </a>
        ))}
      </nav>
    );
  }

  return (
    <nav className={cn("hidden flex-wrap items-center gap-2 lg:flex", className)}>
      {links.map((link) => (
        <a
          key={`${link.href}:${link.label}`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          href={link.href}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
