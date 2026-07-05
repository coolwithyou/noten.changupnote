/**
 * pdfjs-dist(4.x)는 exports 맵/서브패스 d.ts 가 없어 legacy 빌드 경로의 타입이 해석되지 않는다.
 * Node/tsx 환경에서 텍스트 추출에 쓰는 legacy 빌드의 타입을 메인 패키지 타입으로 재노출한다.
 */
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
