import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PageNav({
  links,
  className,
}: {
  links: Array<{ href: string; label: string }>;
  className?: string;
}) {
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
