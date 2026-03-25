import type { EmailMeta, MatchCondition, Rule, RulesFile, Action } from "./schemas.js";

// ─── Template interpolation ───────────────────────────────────────────────────

const TEMPLATE_VARS = ["from", "from_domain", "to", "subject", "folder", "uid", "body_preview"] as const;

export function interpolate(template: string, email: EmailMeta): string {
  let result = template;
  for (const key of TEMPLATE_VARS) {
    const value = key === "uid" ? String(email.uid) : email[key] ?? "";
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

// ─── Match evaluation ─────────────────────────────────────────────────────────

function getField(email: EmailMeta, field: MatchCondition extends { field: infer F } ? F : never): string {
  // @ts-expect-error — field is always a valid key after schema validation
  return String(email[field] ?? "");
}

function evalLeaf(
  email: EmailMeta,
  field: string,
  op: string,
  value: string,
  case_sensitive: boolean
): boolean {
  const haystack = case_sensitive ? getField(email, field as never) : getField(email, field as never).toLowerCase();
  const needle = case_sensitive ? value : value.toLowerCase();

  switch (op) {
    case "equals": return haystack === needle;
    case "not_equals": return haystack !== needle;
    case "contains": return haystack.includes(needle);
    case "not_contains": return !haystack.includes(needle);
    case "starts_with": return haystack.startsWith(needle);
    case "ends_with": return haystack.endsWith(needle);
    case "matches": {
      try {
        // Dynamic RegExp is intentional — this is the user-defined 'matches' operator
        // in the rule engine. value comes from the user's own rules.json config,
        // not from inbound email content. Already wrapped in try/catch for invalid patterns.
        // nosec: dynamic-regexp
        return new RegExp(value, case_sensitive ? undefined : "i").test(getField(email, field as never));
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

export function evalCondition(email: EmailMeta, condition: MatchCondition): boolean {
  if ("operator" in condition) {
    switch (condition.operator) {
      case "AND": return condition.conditions.every(c => evalCondition(email, c));
      case "OR": return condition.conditions.some(c => evalCondition(email, c));
      case "NOT": return !evalCondition(email, condition.condition);
    }
  }
  // Leaf condition
  return evalLeaf(email, condition.field, condition.op, condition.value, condition.case_sensitive);
}

// ─── Rule matching ────────────────────────────────────────────────────────────

export interface MatchResult {
  matched: boolean;
  rule: Rule | null;
  actions: Action[];
}

export function evaluateRules(email: EmailMeta, rulesFile: RulesFile): MatchResult[] {
  const results: MatchResult[] = [];

  for (const rule of rulesFile.rules) {
    if (!rule.enabled) continue;

    const matched = evalCondition(email, rule.match);
    if (matched) {
      results.push({ matched: true, rule, actions: rule.actions });
      if (rule.stop_on_match) break;
    }
  }

  // If nothing matched, apply default action
  if (results.length === 0) {
    results.push({ matched: false, rule: null, actions: [rulesFile.default_action] });
  }

  return results;
}

// ─── Rule testing (for /beemail_rule_test) ────────────────────────────────────

export interface RuleTestResult {
  rule_id: string;
  rule_name: string;
  matched: boolean;
  actions_that_would_run: Action[];
}

export function testRuleAgainstEmail(rule: Rule, email: EmailMeta): RuleTestResult {
  const matched = evalCondition(email, rule.match);
  return {
    rule_id: rule.id,
    rule_name: rule.name,
    matched,
    actions_that_would_run: matched ? rule.actions : [],
  };
}

// ─── Rule file helpers ────────────────────────────────────────────────────────

import { readFile, writeFile, rename } from "fs/promises";
import { RulesFileSchema, type Rule as RuleType } from "./schemas.js";
import { randomUUID } from "crypto";

export async function loadRulesFile(path: string, logger?: { warn: (msg: string) => void }): Promise<RulesFile> {
  try {
    const raw = await readFile(path, "utf-8");
    try {
      return RulesFileSchema.parse(JSON.parse(raw));
    } catch (parseErr) {
      // Distinguish parse/validation errors from file-not-found
      logger?.warn(
        `[bee-push-email] rules.json is malformed or invalid: ${parseErr}. ` +
        `Fix ${path} or delete it to start fresh. Running with empty rules.`
      );
      return RulesFileSchema.parse({});
    }
  } catch {
    // File does not exist — return empty rules silently (expected on first run)
    return RulesFileSchema.parse({});
  }
}

export async function saveRulesFile(path: string, rules: RulesFile): Promise<void> {
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(rules, null, 2), "utf-8");
  await rename(tmp, path); // atomic write — same pattern as saveLastUid in imap.ts
}

export function generateRuleId(): string {
  return `rule_${randomUUID().split("-")[0]}`;
}

export function addRule(rulesFile: RulesFile, rule: Omit<RuleType, "id">): RulesFile {
  const newRule: RuleType = { id: generateRuleId(), ...rule };
  return { ...rulesFile, rules: [...rulesFile.rules, newRule] };
}

export function removeRule(rulesFile: RulesFile, id: string): RulesFile {
  return { ...rulesFile, rules: rulesFile.rules.filter(r => r.id !== id) };
}

export function toggleRule(rulesFile: RulesFile, id: string, enabled: boolean): RulesFile {
  return {
    ...rulesFile,
    rules: rulesFile.rules.map(r => r.id === id ? { ...r, enabled } : r),
  };
}

export function formatRulesList(rulesFile: RulesFile): string {
  if (rulesFile.rules.length === 0) {
    return "No rules defined. Use /beemail_rule_add to create one.";
  }
  const lines = rulesFile.rules.map((r, i) => {
    const status = r.enabled ? "✅" : "⏸";
    const actions = r.actions.map(a => a.type).join(", ");
    return `${status} [${i + 1}] ${r.name} (${r.id})\n   Actions: ${actions}`;
  });
  return `📋 Rules (${rulesFile.rules.length}):\n\n${lines.join("\n\n")}`;
}
