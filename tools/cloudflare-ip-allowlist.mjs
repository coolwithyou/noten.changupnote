#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const zoneName = "changupnote.com";
const hostnames = [
  "changupnote.com",
  "www.changupnote.com",
  "dev.changupnote.com",
  "ops.changupnote.com",
  "dev.ops.changupnote.com",
];
const rulesetName = "changupnote.com IP allowlist";
const ruleDescriptionPrefix = "Block changupnote.com";

const usage = `
Usage:
  node tools/cloudflare-ip-allowlist.mjs status
  node tools/cloudflare-ip-allowlist.mjs restrict 125.184.29.37/32 [CIDR...]
  node tools/cloudflare-ip-allowlist.mjs add 203.0.113.10/32 [CIDR...]
  node tools/cloudflare-ip-allowlist.mjs remove 203.0.113.10/32 [CIDR...]
  node tools/cloudflare-ip-allowlist.mjs enable
  node tools/cloudflare-ip-allowlist.mjs disable
  node tools/cloudflare-ip-allowlist.mjs delete-rule
  node tools/cloudflare-ip-allowlist.mjs proxy-on
  node tools/cloudflare-ip-allowlist.mjs proxy-off

Requires CLOUDFLARE_TOKEN in the shell or in .env.
`;

const command = process.argv[2] ?? "status";
const args = process.argv.slice(3);

function loadEnvToken() {
  if (process.env.CLOUDFLARE_TOKEN) return process.env.CLOUDFLARE_TOKEN;
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  if (!existsSync(".env")) return "";

  const env = readFileSync(".env", "utf8");
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*(CLOUDFLARE_TOKEN|CLOUDFLARE_API_TOKEN)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    return match[2].replace(/^['"]|['"]$/g, "");
  }
  return "";
}

const token = loadEnvToken();

if (!token) {
  console.error("Missing CLOUDFLARE_TOKEN. Put it in .env or export it in the shell.");
  process.exit(1);
}

if (["help", "-h", "--help"].includes(command)) {
  console.log(usage.trim());
  process.exit(0);
}

function assertCidrs(cidrs) {
  if (cidrs.length === 0) {
    console.error(`Command "${command}" requires at least one CIDR.`);
    console.error(usage.trim());
    process.exit(1);
  }

  for (const cidr of cidrs) {
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(cidr)) {
      console.error(`Invalid CIDR-like value: ${cidr}`);
      process.exit(1);
    }
  }
}

async function cf(path, options = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json();

  if (!res.ok || !body.success) {
    const detail = body.errors?.map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${detail || res.statusText}`);
  }

  return body.result;
}

async function getZoneId() {
  const zones = await cf(`/zones?name=${encodeURIComponent(zoneName)}`);
  const zone = zones[0];
  if (!zone) throw new Error(`Cloudflare zone not found: ${zoneName}`);
  return zone.id;
}

async function getDnsRecords(zoneId) {
  const records = await cf(`/zones/${zoneId}/dns_records?per_page=100`);
  return records.filter((record) => hostnames.includes(record.name));
}

async function getEntrypoint(zoneId) {
  try {
    return await cf(`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`);
  } catch (error) {
    if (String(error.message).includes("10003")) return null;
    throw error;
  }
}

function findAllowlistRule(ruleset) {
  return ruleset?.rules?.find((rule) => rule.description?.startsWith(ruleDescriptionPrefix)) ?? null;
}

function buildExpression(cidrs) {
  const hosts = hostnames.map((hostname) => `"${hostname}"`).join(" ");
  return `(http.host in {${hosts}} and not ip.src in {${cidrs.join(" ")}})`;
}

function buildDescription(cidrs) {
  return `Block changupnote.com, www, dev, ops, and dev.ops except ${cidrs.join(", ")}`;
}

function parseCidrs(expression) {
  const match = expression?.match(/not ip\.src in \{([^}]+)\}/);
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

async function upsertRule(zoneId, cidrs, enabled = true) {
  const payloadRule = {
    action: "block",
    expression: buildExpression(cidrs),
    description: buildDescription(cidrs),
    enabled,
  };
  const ruleset = await getEntrypoint(zoneId);

  if (!ruleset) {
    const created = await cf(`/zones/${zoneId}/rulesets`, {
      method: "POST",
      body: JSON.stringify({
        name: rulesetName,
        kind: "zone",
        phase: "http_request_firewall_custom",
        rules: [payloadRule],
      }),
    });
    return { ruleset: created, rule: findAllowlistRule(created), changed: "created" };
  }

  const currentRule = findAllowlistRule(ruleset);
  const rules = currentRule
    ? ruleset.rules.map((rule) => (rule.id === currentRule.id ? { ...rule, ...payloadRule } : rule))
    : [...ruleset.rules, payloadRule];

  const updated = await cf(`/zones/${zoneId}/rulesets/${ruleset.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: ruleset.name,
      kind: ruleset.kind,
      phase: ruleset.phase,
      rules,
    }),
  });
  return { ruleset: updated, rule: findAllowlistRule(updated), changed: currentRule ? "updated" : "added" };
}

async function setRuleEnabled(zoneId, enabled) {
  const ruleset = await getEntrypoint(zoneId);
  const currentRule = findAllowlistRule(ruleset);
  if (!ruleset || !currentRule) throw new Error("Allowlist rule not found.");

  const updated = await cf(`/zones/${zoneId}/rulesets/${ruleset.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: ruleset.name,
      kind: ruleset.kind,
      phase: ruleset.phase,
      rules: ruleset.rules.map((rule) => (rule.id === currentRule.id ? { ...rule, enabled } : rule)),
    }),
  });
  return { ruleset: updated, rule: findAllowlistRule(updated) };
}

async function deleteRule(zoneId) {
  const ruleset = await getEntrypoint(zoneId);
  const currentRule = findAllowlistRule(ruleset);
  if (!ruleset || !currentRule) throw new Error("Allowlist rule not found.");

  const updated = await cf(`/zones/${zoneId}/rulesets/${ruleset.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: ruleset.name,
      kind: ruleset.kind,
      phase: ruleset.phase,
      rules: ruleset.rules.filter((rule) => rule.id !== currentRule.id),
    }),
  });
  return { ruleset: updated };
}

async function setProxy(zoneId, proxied) {
  const records = await getDnsRecords(zoneId);
  const updated = [];
  for (const record of records) {
    updated.push(
      await cf(`/zones/${zoneId}/dns_records/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify({ proxied }),
      }),
    );
  }
  return updated;
}

function printStatus({ zoneId, records, ruleset, rule }) {
  console.log(`zone=${zoneName} (${zoneId})`);
  console.log("dns_records=");
  for (const record of records) {
    console.log(`  ${record.id} ${record.type} ${record.name} -> ${record.content} proxied=${record.proxied}`);
  }
  console.log(`ruleset=${ruleset ? `${ruleset.id} ${ruleset.name}` : "missing"}`);
  if (rule) {
    console.log(`rule=${rule.id} enabled=${rule.enabled} action=${rule.action}`);
    console.log(`expression=${rule.expression}`);
    console.log(`allowed=${parseCidrs(rule.expression).join(", ") || "none"}`);
  } else {
    console.log("rule=missing");
  }
}

async function main() {
  const zoneId = await getZoneId();

  if (command === "status") {
    const [records, ruleset] = await Promise.all([getDnsRecords(zoneId), getEntrypoint(zoneId)]);
    printStatus({ zoneId, records, ruleset, rule: findAllowlistRule(ruleset) });
    return;
  }

  if (command === "restrict") {
    assertCidrs(args);
    const result = await upsertRule(zoneId, args);
    console.log(`${result.changed} rule=${result.rule.id}`);
    console.log(`expression=${result.rule.expression}`);
    return;
  }

  if (command === "add" || command === "remove") {
    assertCidrs(args);
    const ruleset = await getEntrypoint(zoneId);
    const rule = findAllowlistRule(ruleset);
    if (!rule) throw new Error("Allowlist rule not found.");
    const current = new Set(parseCidrs(rule.expression));
    for (const cidr of args) {
      if (command === "add") current.add(cidr);
      else current.delete(cidr);
    }
    if (current.size === 0) {
      throw new Error("Refusing to write an empty allowlist. Use disable to open the site temporarily.");
    }
    const result = await upsertRule(zoneId, [...current].sort(), rule.enabled);
    console.log(`updated rule=${result.rule.id}`);
    console.log(`expression=${result.rule.expression}`);
    return;
  }

  if (command === "enable" || command === "disable") {
    const result = await setRuleEnabled(zoneId, command === "enable");
    console.log(`rule=${result.rule.id} enabled=${result.rule.enabled}`);
    return;
  }

  if (command === "delete-rule") {
    const result = await deleteRule(zoneId);
    console.log(`deleted allowlist rule from ruleset=${result.ruleset.id}`);
    return;
  }

  if (command === "proxy-on" || command === "proxy-off") {
    const records = await setProxy(zoneId, command === "proxy-on");
    for (const record of records) {
      console.log(`${record.id} ${record.type} ${record.name} proxied=${record.proxied}`);
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error(usage.trim());
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
