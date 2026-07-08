package kr.dogfoot.hwp2hwpx.cli;

import kr.dogfoot.hwplib.object.HWPFile;
import kr.dogfoot.hwplib.object.fileheader.FileHeader;
import kr.dogfoot.hwplib.reader.HWPReader;
import kr.dogfoot.hwpxlib.object.HWPXFile;
import kr.dogfoot.hwpxlib.writer.HWPXWriter;
import kr.dogfoot.hwp2hwpx.Hwp2Hwpx;

/**
 * hwp2hwpx CLI 래퍼 (hwp2hwpx 트랙 Phase 1 — 스파이크 산출물 승격).
 *
 * 원본: scripts/spike/hwp2hwpx/Main.java (Phase 0, 자동 3관문 + 한컴 눈검수 통과).
 * 로직 불변 — 프로덕션 Dockerfile 멀티스테이지(maven) 빌드에서 이 파일을 오버레이한다.
 *
 * 절차: HWPReader.fromFile(in) -> Hwp2Hwpx.toHWPX(hwp) -> HWPXWriter.toFilepath(hwpx, out).
 * 성공/실패를 한 줄 태그로 stdout/stderr 에 내보내 호출자(convertHwpToHwpx)가 파싱한다.
 *   성공: "OK version=<v> compressed=<b> distribution=<b> hasPassword=<b> drm=<b>"
 *   실패: stderr 로 "ERR <예외클래스>: <메시지>" + exit 1
 * 실패 사유 분류(HWP 3.x/암호화/배포용/기타)는 호출자가 이 메시지 + 매직바이트로 수행한다.
 */
public class Main {
    public static void main(String[] args) {
        if (args.length < 2) {
            System.err.println("usage: java -jar hwp2hwpx-cli.jar <in.hwp> <out.hwpx>");
            System.exit(2);
            return;
        }
        String in = args[0];
        String out = args[1];
        try {
            HWPFile hwp = HWPReader.fromFile(in);
            // FileHeader 플래그를 최선노력으로 기록(분류 근거). 게터 부재 시 컴파일 실패하므로 방어적 접근.
            String meta = probeHeader(hwp);
            HWPXFile hwpx = Hwp2Hwpx.toHWPX(hwp);
            HWPXWriter.toFilepath(hwpx, out);
            System.out.println("OK " + meta);
        } catch (Throwable t) {
            StringBuilder sb = new StringBuilder();
            Throwable cur = t;
            int depth = 0;
            while (cur != null && depth < 5) {
                if (depth > 0) sb.append(" <= ");
                sb.append(cur.getClass().getName()).append(": ").append(String.valueOf(cur.getMessage()));
                cur = cur.getCause();
                depth++;
            }
            System.err.println("ERR " + sb);
            System.exit(1);
        }
    }

    private static String probeHeader(HWPFile hwp) {
        try {
            FileHeader fh = hwp.getFileHeader();
            String version = String.valueOf(fh.getVersion());
            boolean compressed = fh.isCompressed();
            boolean distribution = fh.isDistribution();
            boolean hasPassword = fh.hasPassword();
            boolean drm = fh.isDRMDocument();
            return "version=" + version
                    + " compressed=" + compressed
                    + " distribution=" + distribution
                    + " hasPassword=" + hasPassword
                    + " drm=" + drm;
        } catch (Throwable ignore) {
            return "version=? (header probe unavailable)";
        }
    }
}
