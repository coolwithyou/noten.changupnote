import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
} from "../src/index.js";

const schemaPath = resolve(process.cwd(), "packages/contracts/schemas/grant-criteria.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as unknown;
const errors: string[] = [];

if (!isRecord(schema)) {
  console.error("grant_criteria schema must be a JSON object.");
  process.exit(1);
}

expectEqual(schema.$schema, "https://json-schema.org/draft/2020-12/schema", "$schema", errors);
expectEqual(
  schema.$id,
  "https://changupnote.com/schemas/grant-criteria.schema.json",
  "$id",
  errors,
);
expectEqual(schema.title, "GrantCriterion", "title", errors);
expectEqual(schema.type, "object", "type", errors);
expectEqual(schema.additionalProperties, false, "additionalProperties", errors);
compareStringArrays(
  getStringArray(schema.required, "required", errors),
  ["dimension", "operator", "value", "kind", "confidence"],
  "required",
  errors,
);

const properties = getRecord(schema.properties, "properties", errors);
if (properties) {
  compareStringArrays(
    getPropertyEnum(properties, "dimension", errors),
    [...CRITERION_DIMENSIONS],
    "properties.dimension.enum",
    errors,
  );
  compareStringArrays(
    getPropertyEnum(properties, "operator", errors),
    [...CRITERION_OPERATORS],
    "properties.operator.enum",
    errors,
  );
  compareStringArrays(
    getPropertyEnum(properties, "kind", errors),
    [...CRITERION_KINDS],
    "properties.kind.enum",
    errors,
  );

  const value = getRecord(properties.value, "properties.value", errors);
  if (value) {
    expectEqual(value.type, "object", "properties.value.type", errors);
    expectEqual(value.additionalProperties, true, "properties.value.additionalProperties", errors);
  }

  const confidence = getRecord(properties.confidence, "properties.confidence", errors);
  if (confidence) {
    expectEqual(confidence.type, "number", "properties.confidence.type", errors);
    expectEqual(confidence.minimum, 0, "properties.confidence.minimum", errors);
    expectEqual(confidence.maximum, 1, "properties.confidence.maximum", errors);
  }
}

if (errors.length > 0) {
  console.error("grant_criteria schema verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("grant_criteria schema verification passed.");

function expectEqual(actual: unknown, expected: unknown, label: string, errors: string[]) {
  if (actual !== expected) {
    errors.push(`${label} expected ${String(expected)} but received ${String(actual)}.`);
  }
}

function getRecord(
  value: unknown,
  label: string,
  errors: string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  return value;
}

function getStringArray(value: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${label} must be a string array.`);
    return [];
  }
  return value;
}

function getPropertyEnum(
  properties: Record<string, unknown>,
  propertyName: string,
  errors: string[],
): string[] {
  const property = getRecord(properties[propertyName], `properties.${propertyName}`, errors);
  if (!property) return [];
  expectEqual(property.type, "string", `properties.${propertyName}.type`, errors);
  return getStringArray(property.enum, `properties.${propertyName}.enum`, errors);
}

function compareStringArrays(
  actual: string[],
  expected: string[],
  label: string,
  errors: string[],
) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    errors.push(`${label} expected ${expectedJson} but received ${actualJson}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
