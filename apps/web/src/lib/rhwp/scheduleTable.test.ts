import assert from "node:assert/strict";
import { loadDocumentAgentCore } from "@/lib/server/rhwp/documentAgentCore";
import type { RhwpDocumentFormat, RhwpModule } from "./client";
import { sha256Hex } from "./documentAgentContract";
import { applyScheduleTablePlan, inspectScheduleTableDocument } from "./scheduleTable";

const rhwp = await loadDocumentAgentCore();

for (const format of ["hwp", "hwpx"] as const) {
  const original = createScheduleFixture(rhwp, format);
  const documentSha256 = await sha256Hex(original);
  const document = new rhwp.HwpDocument(original);
  const inspection = await inspectScheduleTableDocument(document, documentSha256);
  document.free();
  assert.equal(inspection.status, "unique", `${format} 일정표를 하나로 찾아야 합니다: ${JSON.stringify(inspection)}`);
  if (inspection.status !== "unique") continue;
  assert.deepEqual(inspection.target.months, [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(inspection.target.rows.length, 5);

  const result = await applyScheduleTablePlan({
    rhwp,
    bytes: original,
    format,
    target: inspection.target,
    plan: {
      phases: [
        {
          title: "고객 인터뷰와 요구사항 검증",
          startMonth: 5,
          endMonth: 6,
          basis: "검증 일정 권고",
          basisKind: "recommendation",
          evidenceQuote: "",
          assumptions: ["선정 직후 착수하는 일정으로 가정"],
        },
        {
          title: "시제품 제작",
          startMonth: 7,
          endMonth: 8,
          basis: "개발 일정 권고",
          basisKind: "recommendation",
          evidenceQuote: "",
          assumptions: ["인터뷰 완료 뒤 제작하는 일정으로 가정"],
        },
      ],
    },
  });
  assert.notEqual(result.afterDocumentSha256, documentSha256);
  assert.equal(result.target.rows[0]?.title, "고객 인터뷰와 요구사항 검증");
  assert.equal(result.target.rows[1]?.title, "시제품 제작");
  assert.equal(result.target.rows[2]?.title, "-");
  assert.deepEqual(result.target.rows[0]?.monthFillColors, [
    result.target.activeFillColor,
    result.target.activeFillColor,
    result.target.inactiveFillColor,
    result.target.inactiveFillColor,
    result.target.inactiveFillColor,
    result.target.inactiveFillColor,
    result.target.inactiveFillColor,
    result.target.inactiveFillColor,
  ]);
  const appliedDocument = new rhwp.HwpDocument(result.bytes);
  const freshInspection = await inspectScheduleTableDocument(appliedDocument, result.afterDocumentSha256);
  appliedDocument.free();
  assert.equal(freshInspection.status, "unique");
  if (freshInspection.status === "unique") {
    assert.equal(freshInspection.target.activeFillColor, inspection.target.activeFillColor);
    assert.equal(freshInspection.target.inactiveFillColor, inspection.target.inactiveFillColor);
  }

  await assert.rejects(
    () => applyScheduleTablePlan({
      rhwp,
      bytes: result.bytes,
      format,
      target: inspection.target,
      plan: {
        phases: [{
          title: "다시 쓰기",
          startMonth: 5,
          endMonth: 6,
          basis: "권고",
          basisKind: "recommendation",
          evidenceQuote: "",
          assumptions: ["가정"],
        }],
      },
    }),
    /문서가 변경되었습니다/u,
  );
}

console.log("Schedule table HWP/HWPX roundtrip tests passed");

function createScheduleFixture(rhwpModule: RhwpModule, format: RhwpDocumentFormat): Uint8Array {
  const document = rhwpModule.HwpDocument.createEmpty();
  try {
    document.createBlankDocument();
    const created = JSON.parse(document.createTable(0, 0, 0, 6, 9)) as {
      ok?: boolean;
      paraIdx?: number;
      controlIdx?: number;
    };
    assert.equal(created.ok, true);
    const parentPara = created.paraIdx ?? 0;
    const controlIndex = created.controlIdx ?? 0;
    const values = [
      "추진내용", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월",
      "점포 인테리어 추진", "", "", "", "", "", "", "", "",
      "제품개발 기획", "", "", "", "", "", "", "", "",
      "시제품 제작", "", "", "", "", "", "", "", "",
      "테스트 마켓 운영", "", "", "", "", "", "", "", "",
      "-", "", "", "", "", "", "", "", "",
    ];
    values.forEach((value, cellIndex) => {
      if (value) assertOk(document.insertTextInCell(0, parentPara, controlIndex, cellIndex, 0, 0, value));
      if (cellIndex >= 9 && cellIndex % 9 !== 0) {
        const row = Math.floor(cellIndex / 9) - 1;
        const monthIndex = cellIndex % 9 - 1;
        const active = (row === 0 && monthIndex <= 2)
          || (row === 1 && monthIndex >= 2 && monthIndex <= 3)
          || (row === 2 && monthIndex >= 3 && monthIndex <= 4)
          || (row === 3 && monthIndex >= 4 && monthIndex <= 5);
        assertOk(document.setCellProperties(
          0,
          parentPara,
          controlIndex,
          cellIndex,
          JSON.stringify({ fillType: "solid", fillColor: active ? "#f5e3a6" : "#ffffff" }),
        ));
      }
    });
    return format === "hwp" ? document.exportHwp() : document.exportHwpx();
  } finally {
    document.free();
  }
}

function assertOk(value: string): void {
  assert.equal((JSON.parse(value) as { ok?: boolean }).ok, true);
}
