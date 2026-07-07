#!/usr/bin/env bash
# hwp2hwpx uber jar 빌드 (Phase 0 스파이크) — Docker maven 컨테이너.
#
# 절차: neolord0/hwp2hwpx clone -> 커밋 핀 -> 얇은 CLI Main.java + shade pom 오버레이 -> mvn package.
# 재현: 이 스크립트 + PIN_COMMIT + build-pom.xml + Main.java 로 동일 jar 산출.
#
# 산출: spike-out/hwp2hwpx/hwp2hwpx-cli.jar (uber jar, mainClass=kr.dogfoot.hwp2hwpx.cli.Main)
set -euo pipefail

PIN_COMMIT="50ae71bbaf98ec7a00192f72492d6a130a755ac1"   # HEAD @ 2026-06-25 "ForFont 수정.." (핀)
MAVEN_IMAGE="maven:3.9-eclipse-temurin-17"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="$ROOT/spike-out/hwp2hwpx"
CHECKOUT="$OUT/checkout"
M2="$OUT/.m2"

mkdir -p "$OUT" "$M2"

echo "== [1/4] clone + pin =="
if [ ! -d "$CHECKOUT/.git" ]; then
  git clone --quiet https://github.com/neolord0/hwp2hwpx "$CHECKOUT"
fi
git -C "$CHECKOUT" fetch --quiet origin || true
git -C "$CHECKOUT" checkout --quiet "$PIN_COMMIT"
echo "   pinned: $(git -C "$CHECKOUT" rev-parse HEAD)"

echo "== [2/4] overlay CLI Main + shade pom =="
mkdir -p "$CHECKOUT/src/main/java/kr/dogfoot/hwp2hwpx/cli"
cp "$HERE/Main.java" "$CHECKOUT/src/main/java/kr/dogfoot/hwp2hwpx/cli/Main.java"
cp "$HERE/build-pom.xml" "$CHECKOUT/pom.xml"

echo "== [3/4] pull maven image (없으면 다운로드) =="
docker image inspect "$MAVEN_IMAGE" >/dev/null 2>&1 || docker pull "$MAVEN_IMAGE"

echo "== [4/4] mvn package (Docker) =="
docker run --rm \
  -v "$CHECKOUT:/build" \
  -v "$M2:/root/.m2" \
  -w /build \
  "$MAVEN_IMAGE" \
  mvn -q -B -Dmaven.test.skip=true package

JAR="$CHECKOUT/target/hwp2hwpx-cli.jar"
if [ ! -f "$JAR" ]; then
  echo "!! build failed: $JAR 없음" >&2
  exit 1
fi
cp "$JAR" "$OUT/hwp2hwpx-cli.jar"
echo "== DONE: $OUT/hwp2hwpx-cli.jar =="
ls -la "$OUT/hwp2hwpx-cli.jar"
