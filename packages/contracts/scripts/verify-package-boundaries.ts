import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

interface BoundaryRule {
  label: string;
  root: string;
  bannedImports: RegExp[];
}

const workspaceRoot = process.cwd();
const rules: BoundaryRule[] = [
  {
    label: "packages/core/src",
    root: resolve(workspaceRoot, "packages/core/src"),
    bannedImports: [
      /^next(?:\/|$)/,
      /^react(?:\/|$)/,
      /^react-dom(?:\/|$)/,
      /^@\/.*/,
      /^apps\/web(?:\/|$)/,
      /^drizzle-orm(?:\/|$)/,
      /^postgres$/,
    ],
  },
  {
    label: "packages/contracts/src",
    root: resolve(workspaceRoot, "packages/contracts/src"),
    bannedImports: [
      /^next(?:\/|$)/,
      /^react(?:\/|$)/,
      /^react-dom(?:\/|$)/,
      /^@\/.*/,
      /^apps\/web(?:\/|$)/,
      /^@cunote\/core$/,
      /^@cunote\/core\//,
    ],
  },
];

const IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const errors: string[] = [];

for (const rule of rules) {
  for (const file of walkTypeScriptFiles(rule.root)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (isBannedSpecifier(specifier, rule.bannedImports)) {
        errors.push(`${formatFile(file)} imports banned module "${specifier}".`);
      }
      if (specifier.startsWith(".")) {
        const resolved = resolve(dirname(file), specifier);
        if (!resolved.startsWith(rule.root)) {
          errors.push(`${formatFile(file)} imports outside ${rule.label}: "${specifier}".`);
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Package boundary verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Package boundary verification passed.");

function walkTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function isBannedSpecifier(specifier: string, bannedImports: RegExp[]): boolean {
  return bannedImports.some((pattern) => pattern.test(specifier));
}

function formatFile(file: string): string {
  return relative(workspaceRoot, file);
}
