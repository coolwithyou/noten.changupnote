# Phase 2 문서 변환 서버 컨테이너.
# 계획: docs/phase2-conversion-server-implementation-plan.md 3장
#
# 구성: LibreOffice 26.x headless + H2Orestart(HWP 필터) + poppler(pdftoppm/pdftotext)
#       + CJK 폰트(나눔/노토) + python3(pyhwp, markdown 보조) + node 22.
#
# 빌드 검증 절차는 README.md "Docker 빌드 검증" 참조.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
# LibreOffice 프로필은 쓰기 가능 경로여야 한다 (Cloud Run: 읽기전용 루트 FS 대비).
ENV HOME=/tmp/loprofile

# LibreOffice + poppler(pdftoppm/pdftotext) + CJK 폰트 + python(pyhwp) + 유틸
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer libreoffice-calc \
      poppler-utils \
      python3 python3-pip \
      fonts-nanum fonts-nanum-coding fonts-noto-cjk fonts-noto-cjk-extra \
      default-jre-headless \
      curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*

# node 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# pyhwp (hwp5html markdown 보조 경로 — HWP 텍스트 추출용)
RUN pip3 install --break-system-packages pyhwp

# H2Orestart 확장 — 버전 고정 다운로드 후 --shared 설치.
# --shared 로 설치해야 워커별 임시 UserInstallation(프로세스 격리) 에서도 필터가 잡힌다.
ARG H2O_VERSION=0.7.13
RUN curl -fsSL -o /tmp/H2Orestart.oxt \
      "https://github.com/ebandal/H2Orestart/releases/download/v${H2O_VERSION}/H2Orestart.oxt" \
 && unopkg add --shared /tmp/H2Orestart.oxt \
 && unopkg list --shared | grep -qi "H2Orestart" \
 && rm /tmp/H2Orestart.oxt

# soffice 프로필 워밍업(첫 변환 지연 제거) — 빌드 시 1회 헤드리스 기동
RUN mkdir -p "$HOME" && soffice --headless --terminate_after_init || true

WORKDIR /app

# 모노레포 컨텍스트: 루트에서 빌드하고 필요한 워크스페이스만 복사한다.
# (docker build 컨텍스트는 저장소 루트, -f apps/conversion/Dockerfile 로 호출)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/conversion ./apps/conversion

# pnpm 설치 후 core + conversion 빌드
RUN corepack enable && corepack prepare pnpm@latest --activate \
 && pnpm install --frozen-lockfile \
 && pnpm --filter @cunote/core build \
 && pnpm --filter @cunote/conversion build

# 프로세스 격리 모드 활성화 (워커별 임시 UserInstallation).
# H2Orestart 를 --shared 로 설치했으므로 격리 프로필에서도 필터가 잡힌다.
ENV CONVERSION_LO_SHARED_H2O=1

EXPOSE 8080
# 서버 엔트리 (T6): in-process 큐 + HTTP API 3종.
# env CONVERSION_SHARED_SECRET · R2_* · CONVERSION_CONCURRENCY(기본 2) · PORT(기본 8080) 참조.
CMD ["node", "apps/conversion/dist/main.js"]
