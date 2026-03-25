import { z } from "zod";

// ─── IMAP connection config ───────────────────────────────────────────────────

export const ImapConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535).default(993),
  ssl: z.boolean().default(true),
  email: z.string(),
  password: z.string(),
  folder: z.string().default("INBOX"),
  preferred_channel: z.string().default("telegram"),
});

export type ImapConfig = z.infer<typeof ImapConfigSchema>;

// ─── Rule engine — match conditions ──────────────────────────────────────────

export const FieldMatchOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "matches", // regex
]);

export const MatchableFieldSchema = z.enum([
  "from",
  "from_domain",
  "to",
  "subject",
  "folder",
  "body_preview",
]);

export const LeafConditionSchema = z.object({
  field: MatchableFieldSchema,
  op: FieldMatchOperatorSchema,
  value: z.string(),
  case_sensitive: z.boolean().default(false),
});

// Recursive compound condition (AND / OR / NOT)
export type MatchCondition =
  | z.infer<typeof LeafConditionSchema>
  | { operator: "AND"; conditions: MatchCondition[] }
  | { operator: "OR"; conditions: MatchCondition[] }
  | { operator: "NOT"; condition: MatchCondition };

export const MatchConditionSchema: z.ZodType<MatchCondition> = z.lazy(() =>
  z.union([
    LeafConditionSchema,
    z.object({
      operator: z.literal("AND"),
      conditions: z.array(MatchConditionSchema).min(1),
    }),
    z.object({
      operator: z.literal("OR"),
      conditions: z.array(MatchConditionSchema).min(1),
    }),
    z.object({
      operator: z.literal("NOT"),
      condition: MatchConditionSchema,
    }),
  ])
);

// ─── Rule engine — actions ────────────────────────────────────────────────────

export const ActionSchema = z.discriminatedUnion("type", [
  // Send a Telegram notification (supports template vars: {from}, {subject}, {folder}, {uid})
  z.object({
    type: z.literal("notify"),
    template: z.string().optional(),
  }),

  // Silently ignore — no notification, no further actions
  z.object({
    type: z.literal("silence"),
  }),

  // Move email to an IMAP folder
  z.object({
    type: z.literal("move"),
    folder: z.string().min(1),
  }),

  // Mark as read or unread
  z.object({
    type: z.literal("mark_read"),
  }),
  z.object({
    type: z.literal("mark_unread"),
  }),

  // Reply automatically (uses auto_reply_mode from global config)
  z.object({
    type: z.literal("reply"),
    // If provided, used as reply body. Otherwise agent composes it.
    body: z.string().optional(),
  }),

  // Ask the user for approval before replying
  z.object({
    type: z.literal("ask_reply"),
    // Prompt shown to user. Supports {from}, {subject} template vars.
    prompt: z.string().optional(),
  }),

  // Trigger an agent turn with a custom message
  z.object({
    type: z.literal("agent_command"),
    // Natural language instruction for the agent.
    // Supports {from}, {subject}, {folder}, {uid}, {body_preview} template vars.
    message: z.string().min(1),
  }),

  // Forward a notification to a specific channel (e.g. a different Telegram chat)
  z.object({
    type: z.literal("forward"),
    channel: z.string().min(1),
    target: z.string().min(1),
  }),
]);

export type Action = z.infer<typeof ActionSchema>;

// ─── Rule ─────────────────────────────────────────────────────────────────────

export const RuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  // If true, no further rules are evaluated after this one matches
  stop_on_match: z.boolean().default(true),
  match: MatchConditionSchema,
  actions: z.array(ActionSchema).min(1),
});

export type Rule = z.infer<typeof RuleSchema>;

// ─── Rules file (rules.json) ──────────────────────────────────────────────────

export const RulesFileSchema = z.object({
  version: z.literal("1").default("1"),
  // Action taken when no rule matches. Defaults to notifying the user.
  default_action: ActionSchema.default({ type: "notify" }),
  rules: z.array(RuleSchema).default([]),
});

export type RulesFile = z.infer<typeof RulesFileSchema>;

// ─── Plugin config (lives in openclaw.json plugins.entries.bee-push-email) ───
// Fields are FLAT at root level — this matches OpenClaw plugin convention.
// Internally we reconstruct the ImapConfig shape via normalizeConfig().
//
// IMPORTANT: host, email, password are optional here (default to "") so that
// the Gateway can load the plugin even when it's freshly installed with no
// config yet. The plugin detects the unconfigured state at runtime and guides
// the user to /beemail_install instead of crashing the Gateway.

export const PluginConfigSchema = z.object({
  // IMAP connection — flat at root, optional so Gateway boots without config
  host:             z.string().default(""),
  port:             z.number().int().min(1).max(65535).default(993),
  ssl:              z.boolean().default(true),
  email:            z.string().default(""),
  password:         z.string().default(""),
  folder:           z.string().default("INBOX"),
  preferred_channel: z.string().default("telegram"),
  // Rules and reply
  rules_file:       z.string().default("bee-push-email-rules.json"),
  auto_reply_mode:  z.enum(["false", "ask", "true"]).default("false"),
});

export type PluginConfigFlat = z.infer<typeof PluginConfigSchema>;

// Returns true if the config has the minimum required fields to connect
export function isConfigured(flat: PluginConfigFlat): boolean {
  return flat.host.trim().length > 0
    && flat.email.trim().length > 0
    && flat.password.trim().length > 0;
}

// Internal shape used throughout the plugin — keeps imap grouped for clarity
export interface PluginConfig {
  imap: ImapConfig;
  rules_file: string;
  auto_reply_mode: "false" | "ask" | "true";
}

// Convert flat validated config → internal grouped shape
export function normalizeConfig(flat: PluginConfigFlat): PluginConfig {
  return {
    imap: {
      host: flat.host,
      port: flat.port,
      ssl: flat.ssl,
      email: flat.email,
      password: flat.password,
      folder: flat.folder,
      preferred_channel: flat.preferred_channel,
    },
    rules_file: flat.rules_file,
    auto_reply_mode: flat.auto_reply_mode,
  };
}

// ─── Runtime email metadata (fetched via imapflow) ───────────────────────────

export const EmailMetaSchema = z.object({
  uid: z.number().int(),
  from: z.string(),
  from_domain: z.string(),
  to: z.string(),
  subject: z.string(),
  folder: z.string(),
  body_preview: z.string(), // first ~300 chars of plain text body
  received_at: z.date(),
});

export type EmailMeta = z.infer<typeof EmailMetaSchema>;
