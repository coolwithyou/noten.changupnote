// T6: 서버 프로세스 엔트리포인트 (Dockerfile CMD).
// env 에서 R2/시크릿을 읽어 HTTP 서버를 기동한다.
// HWP→markdown 은 core 어댑터(pyhwp)를 주입한다.

import { bootstrapFromEnv } from "./server.js";
import { hwpToMarkdown } from "./hwp-markdown-adapter.js";
import { hwpxConvert } from "./hwpx-convert.js";

const port = Number(process.env.PORT ?? "8080") || 8080;
const server = bootstrapFromEnv({ hwpToMarkdown, hwpxConvert });

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[conversion] listening on :${port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
