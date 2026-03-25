/**
 * Setup wizard prompts — used by the OpenClaw agent during:
 * 1. /beemail_install — first-time guided configuration (plugin loaded, config missing/incomplete)
 * 2. /beemail_reconfigure — change specific fields on an existing working install
 *
 * Both commands delegate to the agent via agentFallbackPrompt. The agent asks
 * questions one at a time, accepts natural language answers, uses defaults for
 * optional fields, and writes to openclaw.json only after explicit confirmation.
 *
 * Config structure (flat, as of v2.5.0):
 *   plugins.entries.bee-push-email.config.host
 *   plugins.entries.bee-push-email.config.email
 *   plugins.entries.bee-push-email.config.password
 *   ... (no nesting under "imap")
 */

// ─── Question definitions ─────────────────────────────────────────────────────

export interface SetupQuestion {
  /** Key in the flat config object */
  field: string;
  label: string;
  description: string;
  example: string;
  default_value: string | number | boolean;
  /** Human-readable label shown alongside the default */
  default_label: string;
  required: boolean;
  /** Mask in confirmations and summaries */
  sensitive: boolean;
  parse: (answer: string, current?: unknown) => unknown;
}

export const SETUP_QUESTIONS: SetupQuestion[] = [
  {
    field: "host",
    label: "IMAP server hostname",
    description:
      "The address of your email provider's IMAP server. " +
      "You can usually find this in your email client settings or your provider's help page.\n\n" +
      "Common values:\n" +
      "• Gmail → imap.gmail.com\n" +
      "• Outlook / Office 365 → outlook.office365.com\n" +
      "• Yahoo → imap.mail.yahoo.com\n" +
      "• Self-hosted → mail.yourdomain.com",
    example: "imap.gmail.com",
    default_value: "",
    default_label: "(required — no default)",
    required: true,
    sensitive: false,
    parse: (v) => v.trim().toLowerCase(),
  },
  {
    field: "email",
    label: "Email address",
    description:
      "Your full email address. This is used as both the IMAP login username " +
      "and to identify which inbox to watch.",
    example: "you@gmail.com",
    default_value: "",
    default_label: "(required — no default)",
    required: true,
    sensitive: false,
    parse: (v) => v.trim().toLowerCase(),
  },
  {
    field: "password",
    label: "Password or app-specific password",
    description:
      "Your email password. If your provider supports two-factor authentication " +
      "(Gmail, Outlook, Yahoo), use an app-specific password instead of your main password — " +
      "it's more secure and won't break if you change your main password.\n\n" +
      "How to create app passwords:\n" +
      "• Gmail → myaccount.google.com → Security → App passwords\n" +
      "• Outlook → account.microsoft.com → Security → App passwords\n" +
      "• Yahoo → account.yahoo.com → Security → Generate app password\n\n" +
      "This value is stored in openclaw.json. Protect that file with: chmod 600 ~/.openclaw/openclaw.json",
    example: "abcd efgh ijkl mnop",
    default_value: "",
    default_label: "(required — no default)",
    required: true,
    sensitive: true,
    parse: (v) => v.trim(),
  },
  {
    field: "port",
    label: "IMAP port",
    description:
      "The port number for the IMAP connection.\n\n" +
      "• 993 — SSL/TLS (encrypted, recommended for almost all providers)\n" +
      "• 143 — unencrypted or STARTTLS (only if your provider requires it)\n\n" +
      "Leave blank to use 993.",
    example: "993",
    default_value: 993,
    default_label: "993 (SSL/TLS — recommended)",
    required: false,
    sensitive: false,
    parse: (v, current) => {
      const n = parseInt(v.trim(), 10);
      return isNaN(n) ? (current ?? 993) : n;
    },
  },
  {
    field: "ssl",
    label: "Use SSL/TLS encryption",
    description:
      "Whether to use an encrypted connection. Should be true for almost everyone.\n\n" +
      "Only set to false for local test servers or providers that explicitly require unencrypted connections.",
    example: "yes",
    default_value: true,
    default_label: "yes (recommended)",
    required: false,
    sensitive: false,
    parse: (v) => !["no", "false", "0", "n"].includes(v.trim().toLowerCase()),
  },
  {
    field: "folder",
    label: "IMAP folder to monitor",
    description:
      "The mailbox folder to watch for new emails. INBOX works for most setups.\n\n" +
      "Other examples:\n" +
      "• A work label → Work\n" +
      "• Gmail label → [Gmail]/Important\n" +
      "• Nested folder → Projects/Client-A\n\n" +
      "Folder names are case-sensitive on most servers.",
    example: "INBOX",
    default_value: "INBOX",
    default_label: "INBOX",
    required: false,
    sensitive: false,
    parse: (v, current) => v.trim() || (current ?? "INBOX"),
  },
  {
    field: "auto_reply_mode",
    label: "Auto-reply mode",
    description:
      "Controls whether the agent can reply to senders on your behalf.\n\n" +
      "• false (recommended) — agent NEVER replies. Only notifies you via Telegram. " +
        "Safest option: prevents accidental replies to spam or phishing.\n\n" +
      "• ask — agent notifies you and asks YES/NO approval before every reply. " +
        "You stay in control of all outgoing messages.\n\n" +
      "• true — agent may reply automatically based on rules. " +
        "⚠️ Use with caution: exposes that an AI is managing your inbox.\n\n" +
      "You can change this later with /beemail_reply_off, /beemail_reply_ask, or /beemail_reply_on.",
    example: "false",
    default_value: "false",
    default_label: "false (never reply — safest)",
    required: false,
    sensitive: false,
    parse: (v) => {
      const normalized = v.trim().toLowerCase();
      if (normalized === "ask") return "ask";
      if (["true", "yes", "1"].includes(normalized)) return "true";
      return "false";
    },
  },
  {
    field: "rules_file",
    label: "Rules file path",
    description:
      "Path to the JSON file where email rules are stored. Rules define what happens " +
      "when specific emails arrive — notify, silence, move, auto-reply, run agent commands.\n\n" +
      "A relative path is resolved from your OpenClaw workspace (~/.openclaw/workspace/). " +
      "An absolute path is used as-is.\n\n" +
      "The file will be created automatically on first use. " +
      "Manage rules with /beemail_rule_add after setup.",
    example: "bee-push-email-rules.json",
    default_value: "bee-push-email-rules.json",
    default_label: "bee-push-email-rules.json (in workspace)",
    required: false,
    sensitive: false,
    parse: (v, current) => v.trim() || (current ?? "bee-push-email-rules.json"),
  },
  {
    field: "preferred_channel",
    label: "Preferred notification channel",
    description:
      "The channel where email notifications should be delivered.\n\n" +
      "If you primarily use Telegram, leave this as 'telegram'. " +
      "Other options: discord, whatsapp, slack.\n\n" +
      "This is a preference hint — the plugin always delivers to your last active session first. " +
      "You can override delivery per-rule using the 'forward' action.",
    example: "telegram",
    default_value: "telegram",
    default_label: "telegram",
    required: false,
    sensitive: false,
    parse: (v, current) => v.trim().toLowerCase() || (current ?? "telegram"),
  },
];

// ─── Shared helpers ───────────────────────────────────────────────────────────

function formatSummaryLine(q: SetupQuestion, value: unknown): string {
  const display = q.sensitive ? "****" : String(value ?? q.default_value);
  return `• ${q.label}: ${display || "(not set)"}`;
}

function questionBlock(q: SetupQuestion, index: number): string {
  return [
    `### ${index + 1}. ${q.label}${q.required ? " (required)" : " (optional)"}`,
    ``,
    q.description,
    ``,
    `Default: ${q.default_label}`,
    `Example: ${q.example}`,
  ].join("\n");
}

// ─── /beemail_install — first-time setup ─────────────────────────────────────

export function buildInstallWizardPrompt(): string {
  return `I'll help you set up bee-push-email step by step. I need a few details about your email account — I'll ask one question at a time.

**A few notes before we start:**
- Config will be saved to \`openclaw.json\` under \`plugins.entries.bee-push-email.config\`
- All fields go at the root of the config object (not nested under "imap")
- I'll ask you to confirm before saving anything
- The Gateway needs a restart after saving

---

Let's start with the most important field:

**Question 1 of 9 — IMAP server hostname** *(required)*

This is the address of your email provider's IMAP server. Common values:
- Gmail → \`imap.gmail.com\`
- Outlook / Office 365 → \`outlook.office365.com\`
- Yahoo → \`imap.mail.yahoo.com\`
- Self-hosted → \`mail.yourdomain.com\`

What is your IMAP server hostname?`;
}

// ─── /beemail_reconfigure — change fields on a running install ────────────────

export interface CurrentConfig {
  host: string;
  email: string;
  password: string;
  port: number;
  ssl: boolean;
  folder: string;
  auto_reply_mode: string;
  rules_file: string;
  preferred_channel: string;
}

export function buildReconfigureWizardPrompt(current: CurrentConfig): string {
  const currentDisplay = [
    `• Host: ${current.host || "not set"}`,
    `• Email: ${current.email || "not set"}`,
    `• Password: ${current.password ? "****" : "not set"}`,
    `• Port: ${current.port}  |  SSL: ${current.ssl ? "yes" : "no"}`,
    `• Folder: ${current.folder}`,
    `• Auto-reply: ${current.auto_reply_mode}`,
    `• Rules file: ${current.rules_file}`,
    `• Channel: ${current.preferred_channel}`,
  ].join("\n");

  return `Here's your current bee-push-email configuration:

${currentDisplay}

Which field would you like to change? You can say:
- A field name (e.g. "password", "host", "folder")
- "connection" to update host, port, ssl, and email together
- "credentials" to update host, email, and password
- "all" to go through every field

I'll show you the current value, explain what it does, and ask for the new value. I won't save anything until you confirm.

**Note:** config fields are flat — they go directly under \`plugins.entries.bee-push-email.config\`, not nested under "imap". After saving I'll remind you to restart the Gateway.`;
}
