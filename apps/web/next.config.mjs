/** @type {import('next').NextConfig} */
const nextConfig = {
  // dev 서버가 점유한 .next와 충돌하지 않고 병행 검증 빌드를 돌릴 수 있게 하는 오버라이드.
  // 예: NEXT_DIST_DIR=.next-build pnpm --filter @cunote/web build
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  transpilePackages: ["@cunote/core", "@cunote/contracts"],
  // Cloudflare 터널(dev.changupnote.com) 경유 시 브라우저 Origin이
  // localhost가 아니라서 Next dev의 cross-origin 보호가 HMR/_next 자산 요청을
  // 차단(cloudflared에는 "Unauthorized" malformed 응답으로 보임)하는 것을 허용.
  allowedDevOrigins: ["dev.changupnote.com"],
};

export default nextConfig;
