import type { ImapService } from "./imap.js";
import type { RulesFile, EmailMeta } from "./schemas.js";
import {
  formatRulesList,
  toggleRule,
  removeRule,
  saveRulesFile,
  testRuleAgainstEmail,
} from "./rules.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandContext {
  args: string;
  imap: ImapService | null; // null if service hasn't started yet
  rulesFile: RulesFile;
  rulesPath: string;
  onRulesChanged: (rules: RulesFile) => void;
}

export interface CommandResult {
  text: string;
}

// ─── /beemail ─────────────────────────────────────────────────────────────────

export function cmdStatus(ctx: CommandContext): CommandResult {
  const connected = ctx.imap?.isConnected() ?? false;
  const starting = ctx.imap === null;
  const ruleCount = ctx.rulesFile.rules.length;
  const activeRules = ctx.rulesFile.rules.filter(r => r.enabled).length;
  const notifOn = ctx.rulesFile.default_action.type !== "silence";

  // Detect unconfigured state — imap is null AND no host suggests not set up yet
  const unconfigured = starting && ruleCount === 0;

  return {
    text: [
      `🐝 bee-push-email`,
      ``,
      unconfigured
        ? `⚙️  Not configured. Send /beemail_install to get started.`
        : `IMAP: ${starting ? "⏳ starting..." : connected ? "✅ connected" : "❌ disconnected"}`,
      unconfigured ? `` : `Notifications: ${notifOn ? "🔔 on" : "🔕 off (silenced by default)"}`,
      unconfigured ? `` : `Rules: ${activeRules} active / ${ruleCount} total`,
      ``,
      unconfigured
        ? `Run /beemail_install to configure your email connection.`
        : `Commands: /beemail_notif_on /beemail_notif_off /beemail_rules /beemail_reply_off /beemail_reply_ask /beemail_reply_on`,
    ].filter(Boolean).join("\n"),
  };
}

// ─── /beemail_notif_on / off ──────────────────────────────────────────────────

export async function cmdNotifOn(ctx: CommandContext): Promise<CommandResult> {
  const updated: RulesFile = { ...ctx.rulesFile, default_action: { type: "notify" } };
  await saveRulesFile(ctx.rulesPath, updated);
  ctx.onRulesChanged(updated);
  return { text: "🔔 Notifications ON — you'll be notified for every email that doesn't match a specific rule." };
}

export async function cmdNotifOff(ctx: CommandContext): Promise<CommandResult> {
  const updated: RulesFile = { ...ctx.rulesFile, default_action: { type: "silence" } };
  await saveRulesFile(ctx.rulesPath, updated);
  ctx.onRulesChanged(updated);
  return { text: "🔕 Notifications OFF — emails will be silenced by default. Your existing rules still apply." };
}

// ─── /beemail_rules ───────────────────────────────────────────────────────────

export function cmdRulesList(ctx: CommandContext): CommandResult {
  return { text: formatRulesList(ctx.rulesFile) };
}

// ─── /beemail_rule_toggle <id> ────────────────────────────────────────────────

export async function cmdRuleToggle(ctx: CommandContext): Promise<CommandResult> {
  const [id, state] = ctx.args.trim().split(/\s+/);

  if (!id) {
    return { text: "Usage: /beemail_rule_toggle <rule_id> [on|off]\nGet rule IDs with /beemail_rules" };
  }

  const rule = ctx.rulesFile.rules.find(r => r.id === id);
  if (!rule) {
    return { text: `Rule '${id}' not found. Use /beemail_rules to list rules.` };
  }

  const enabled = state === "on" ? true : state === "off" ? false : !rule.enabled;
  const updated = toggleRule(ctx.rulesFile, id, enabled);
  await saveRulesFile(ctx.rulesPath, updated);
  ctx.onRulesChanged(updated);

  return {
    text: `Rule '${rule.name}' is now ${enabled ? "✅ enabled" : "⏸ disabled"}.`,
  };
}

// ─── /beemail_rule_delete <id> ────────────────────────────────────────────────

export async function cmdRuleDelete(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.trim();

  if (!id) {
    return { text: "Usage: /beemail_rule_delete <rule_id>\nGet rule IDs with /beemail_rules" };
  }

  const rule = ctx.rulesFile.rules.find(r => r.id === id);
  if (!rule) {
    return { text: `Rule '${id}' not found. Use /beemail_rules to list rules.` };
  }

  const updated = removeRule(ctx.rulesFile, id);
  await saveRulesFile(ctx.rulesPath, updated);
  ctx.onRulesChanged(updated);

  return { text: `Rule '${rule.name}' deleted.` };
}

// ─── /beemail_rule_test <id> ──────────────────────────────────────────────────
// Tests a rule against the last received email (stored in memory)

export function cmdRuleTest(
  ctx: CommandContext,
  lastEmail: EmailMeta | null
): CommandResult {
  const id = ctx.args.trim();

  if (!id) {
    return { text: "Usage: /beemail_rule_test <rule_id>\nTests the rule against the last received email." };
  }

  const rule = ctx.rulesFile.rules.find(r => r.id === id);
  if (!rule) {
    return { text: `Rule '${id}' not found.` };
  }

  if (!lastEmail) {
    return { text: "No email received yet since the plugin started. Send a test email first." };
  }

  const result = testRuleAgainstEmail(rule, lastEmail);

  const lines = [
    `🧪 Rule test: '${rule.name}'`,
    ``,
    `Email: ${lastEmail.from}`,
    `Subject: ${lastEmail.subject}`,
    ``,
    result.matched ? `✅ MATCH — these actions would run:` : `❌ NO MATCH`,
  ];

  if (result.matched) {
    for (const action of result.actions_that_would_run) {
      lines.push(`  • ${action.type}`);
    }
  }

  return { text: lines.join("\n") };
}

// ─── /beemail_rule_add ────────────────────────────────────────────────────────
// This command is intentionally handled by the LLM agent (not a direct handler)
// because building rules interactively benefits from natural language guidance.
// The agent uses the schema documentation below to construct the rule JSON.

export const RULE_ADD_AGENT_PROMPT = `
The user wants to add a new email rule to bee-push-email.

Guide them through creating a rule by asking:
1. What emails should this rule match? (sender, domain, subject keywords, or combinations)
2. What should happen when an email matches? (notify, silence, move, mark read, reply, ask for approval, run an agent command)
3. Should the rule stop processing further rules when it matches? (default: yes)

Once you have the information, construct a JSON rule matching this schema and save it using the available tools.

Available action types:
- notify: send notification to the user (optional template with {from}, {subject}, {folder})
- silence: ignore the email completely  
- move: move to IMAP folder (requires 'folder' field)
- mark_read / mark_unread: change read status
- reply: auto-reply (requires auto_reply_mode != 'false' in config)
- ask_reply: ask user for approval before replying (optional 'prompt' template)
- agent_command: trigger agent with custom instructions (required 'message' field with instructions)
- forward: forward notification to another channel (requires 'channel' and 'target' fields)

Match condition examples:
- Single: {"field": "from_domain", "op": "equals", "value": "github.com"}
- AND: {"operator": "AND", "conditions": [...]}
- OR: {"operator": "OR", "conditions": [...]}
- NOT: {"operator": "NOT", "condition": {...}}

Available fields: from, from_domain, to, subject, folder, body_preview
Available operators: equals, not_equals, contains, not_contains, starts_with, ends_with, matches (regex)
`;
