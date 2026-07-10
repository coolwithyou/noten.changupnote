const LINKS: Array<{ href: string; label: string }> = [
  { href: "/credits", label: "대시보드" },
  { href: "/credits/members", label: "회원" },
  { href: "/credits/payments", label: "결제" },
  { href: "/credits/subscriptions", label: "구독" },
  { href: "/credits/pricing", label: "요율" },
  { href: "/credits/settings", label: "설정" },
  { href: "/credits/audit", label: "감사" },
  { href: "/credits/reconciliation", label: "대사" },
];

export function CreditsNav() {
  return (
    <nav className="ops-nav" style={{ margin: "0 auto 16px" }}>
      {LINKS.map((link) => (
        <a href={link.href} key={link.href}>
          {link.label}
        </a>
      ))}
      <a href="/" style={{ marginLeft: "auto" }}>
        ← 홈
      </a>
    </nav>
  );
}
