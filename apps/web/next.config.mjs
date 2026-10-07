/** @type {import('next').NextConfig} */
const nextConfig = {
  // dev 서버가 점유한 .next와 충돌하지 않고 병행 검증 빌드를 돌릴 수 있게 하는 오버라이드.
  // 예: NEXT_DIST_DIR=.next-build pnpm --filter @cunote/web build
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  transpilePackages: ["@cunote/core", "@cunote/contracts"],
  // Dev-only analysis routes use dynamic filesystem paths under the monorepo root. NFT can
  // conservatively trace the whole repository into every server function, including large
  // samples and design artifacts. None of these paths are runtime inputs for production routes.
  outputFileTracingExcludes: {
    "/*": [
      "../../_ir_review_tmp/**/*",
      "../../backups/**/*",
      "../../db/**/*",
      "../../docs/**/*",
      "../../output/**/*",
      "../../spike-out*/**/*",
      "../../spike-samples*/**/*",
      "../../spike-labels/**/*",
      "../../temp/**/*",
      "../../tmp/**/*",
      "public/**/*",
      "src/**/*.test.*",
      "src/lib/server/ingestion/.renorm-analysis/**/*",
      "src/lib/server/layout-eval/eval-cache/**/*",
    ],
  },
  outputFileTracingIncludes: {
    // documentAgentCore는 정적 import로 번들된 JS와 별도로 require.resolve를 사용해
    // 같은 패키지의 WASM sidecar 위치를 찾는다. WASM 하나만 추적하면 Vercel 함수에서
    // 패키지 엔트리가 사라져 require.resolve("@rhwp/core")가 실패하므로 패키지 경계를
    // 함께 보존한다.
    "/*": ["./node_modules/@rhwp/core/**/*"],
  },
  // Cloudflare 터널(dev.changupnote.com) 경유 시 브라우저 Origin이
  // localhost가 아니라서 Next dev의 cross-origin 보호가 HMR/_next 자산 요청을
  // 차단(cloudflared에는 "Unauthorized" malformed 응답으로 보임)하는 것을 허용.
  allowedDevOrigins: ["dev.changupnote.com"],
};

export default nextConfig;
