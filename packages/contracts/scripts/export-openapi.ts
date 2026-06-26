import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appV1OpenApi } from "../src/openapi.js";

export const APP_V1_OPENAPI_OUTPUT = "packages/contracts/generated/app-v1.openapi.json";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outputPath = resolve(workspaceRoot, APP_V1_OPENAPI_OUTPUT);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(appV1OpenApi, null, 2)}\n`);

console.log(`Exported ${APP_V1_OPENAPI_OUTPUT}`);
