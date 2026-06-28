import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "창업노트",
  description: "실사업자 기반 정부지원사업 매칭 콘솔",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="font-sans">
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          as="style"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
