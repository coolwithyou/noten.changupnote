/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@cunote/core", "@cunote/contracts"],
  // Cloudflare 터널(dev.changupnote.com) 경유 시 브라우저 Origin이
  // localhost가 아니라서 Next dev의 cross-origin 보호가 HMR/_next 자산 요청을
  // 차단(cloudflared에는 "Unauthorized" malformed 응답으로 보임)하는 것을 허용.
  allowedDevOrigins: ["dev.changupnote.com"],
};

export default nextConfig;
