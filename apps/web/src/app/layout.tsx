import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "창업노트",
  description: "실사업자 기반 정부지원사업 매칭 콘솔",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="font-sans">
      <body>{children}</body>
    </html>
  );
}
