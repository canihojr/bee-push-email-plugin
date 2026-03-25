import { join, resolve } from "path";
import { homedir } from "os";
import { ImapService } from "./imap.js";
import { executeActions, type AgentRuntime } from "./actions.js";
import { evaluateRules, loadRulesFile } from "./rules.js";
import { PluginConfigSchema, normalizeConfig, isConfigured, type RulesFile, type EmailMeta, type PluginConfig } from "./schemas.js";
import {
  cmdStatus,
  cmdRulesList,
  cmdRuleToggle,
  cmdRuleDelete,
  cmdRuleTest,
  cmdNotifOn,
  cmdNotifOff,
} from "./commands.js";

// ─── Plugin state (lives in-process with the Gateway) ────────────────────────

let imapService: ImapService | null = null;
let rulesFile: RulesFile | null = null;
let rulesPath: string = "";
let pluginConfig: PluginConfig | null = null;
let lastEmail: EmailMeta | null = null;

// Singleton guard — OpenClaw may call register() more than once if the plugin
// is discovered from multiple paths (e.g. both extensions/ and load.paths).
// Without this guard each call starts an independent IMAP service and the user
// receives duplicate notifications.
let registered = false;

// ─── Plugin entry point ───────────────────────────────────────────────────────

// NOTE: OpenClaw calls this function at Gateway startup.
// `api` is the OpenClawPluginApi object — typed loosely here until
// we have the official TypeScript SDK types bundled.
export default function register(api: any): void {
  if (registered) {
    // Already registered from a previous discovery path — skip silently.
    // This prevents duplicate IMAP services and notification spam.
    api.logger?.info("[bee-push-email] Skipping duplicate registration");
    return;
  }
  registered = true;

  const logger = {
    info: (msg: string) => api.logger.info(msg),
    warn: (msg: string) => api.logger.warn(msg),
    error: (msg: string) => api.logger.error(msg),
  };

  // ── 1. Parse config ──
  // api.config may be the full openclaw.json root OR just the plugin config block
  // depending on the Gateway version. Navigate to the plugin config if needed.
  const fullConfig = api.config ?? {};
  const rawConfig: Record<string, unknown> =
    (fullConfig as any)?.plugins?.entries?.["bee-push-email"]?.config
    ?? (fullConfig as any)?.config
    ?? fullConfig;

  logger.info(`[bee-push-email] Config keys: [${Object.keys(rawConfig).join(", ") || "none"}]`);

  const configResult = PluginConfigSchema.safeParse(rawConfig);
  if (!configResult.success) {
    logger.warn(`[bee-push-email] Config parse failed: ${configResult.error.message}`);
  }

  const flatConfig = configResult.success ? configResult.data : PluginConfigSchema.parse({});
  pluginConfig = normalizeConfig(flatConfig);

  // Detect fresh install — host/email/password are empty
  const configured = isConfigured(flatConfig);
  if (!configured) {
    logger.info(
      "[bee-push-email] Plugin loaded but not configured. " +
      "Use /beemail_install to set up your email connection."
    );
  }

  // Resolve rules file path
  const workspace = api.runtime?.workspacePath ?? join(homedir(), ".openclaw", "workspace");
  rulesPath = pluginConfig.rules_file.startsWith("/")
    ? pluginConfig.rules_file
    : resolve(workspace, pluginConfig.rules_file);

  // ── 2. Build the AgentRuntime bridge ──

  // Delivery: CLI subprocess only.
  // enqueueSystemEvent re-queues on every agent heartbeat → duplicate notifications.
  // The CLI subprocess delivers exactly once and does not retry automatically.
  const runtime: AgentRuntime = {
    enqueueSystemEvent: async (message: string) => {
      // Try api.runtime.deliver first (direct push, no heartbeat re-fire)
      if (typeof api.runtime?.deliver === "function") {
        try {
          await api.runtime.deliver({ message, target: "last" });
          logger.info("[bee-push-email] Delivered via api.runtime.deliver");
          return;
        } catch (err) {
          logger.warn(`[bee-push-email] deliver() failed: ${err}`);
        }
      }

      // CLI fallback — delivers exactly once, never re-fires
      // DO NOT fall back to enqueueSystemEvent — it causes repeated delivery
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      const cliArgs = ["agent", "--agent", "main", "--deliver", "--message", message];
      if (lastChatId && /^-?\d+$/.test(lastChatId)) cliArgs.push("--to", lastChatId);
      try {
        await execFileAsync("openclaw", cliArgs, { timeout: 10_000 });
        logger.info("[bee-push-email] Delivered via CLI --agent main");
      } catch (err) {
        logger.error(`[bee-push-email] Delivery failed: ${err}`);
      }
    },
    logger,
  };

  // ── 3. Register the background IMAP service ──

  if (api.registrationMode !== "full") {
    // In CLI/config-validation mode — skip starting the background service
    return;
  }

  api.registerService({
    id: "bee-push-email-imap",
    start: async () => {
      // Skip if not configured — user needs to run /beemail_install first
      if (!isConfigured(flatConfig)) {
        logger.info(
          "[bee-push-email] IMAP service skipped — not configured. " +
          "Send /beemail_install to your agent to complete setup."
        );
        return;
      }

      // Load rules file — pass logger so parse errors surface as warnings
      rulesFile = await loadRulesFile(rulesPath, logger);
      logger.info(
        `[bee-push-email] Loaded ${rulesFile.rules.length} rules from ${rulesPath}`
      );

      // Start IMAP IDLE watcher
      // pluginConfig is guaranteed non-null here: the registerService block is only
      // reached after PluginConfigSchema.safeParse succeeds and assigns pluginConfig.
      const config = pluginConfig;
      if (!config) {
        logger.error("[bee-push-email] pluginConfig unexpectedly null at service start — aborting");
        return;
      }
      const statePath = resolve(workspace, "bee-push-email-uid-state.json");
      imapService = new ImapService(
        config.imap,
        statePath,
        async ({ emails }) => {
          // Called for every batch of new emails
          if (!rulesFile || !imapService || !pluginConfig) return;

          for (const email of emails) {
            lastEmail = email; // store for /beemail_rule_test

            // Evaluate rules and execute matching actions
            const matches = evaluateRules(email, rulesFile);
            for (const match of matches) {
              logger.info(
                `[bee-push-email] UID ${email.uid}: ` +
                (match.rule ? `rule '${match.rule.name}' matched` : "default action")
              );
              await executeActions(match.actions, email, imapService, runtime, pluginConfig);
            }
          }
        },
        logger
      );

      await imapService.start();
      logger.info("[bee-push-email] IMAP IDLE watcher started");
    },
    stop: async () => {
      await imapService?.stop();
      imapService = null;
      logger.info("[bee-push-email] IMAP IDLE watcher stopped");
    },
  });

  // ── 4. Register Telegram commands ──

  // Store the last known chatId so the IMAP service can deliver notifications
  // to the right Telegram chat. Captured from any command invocation context.
  let lastChatId: string | null = null;

  const getCtx = (args = "", cmdCtx?: any) => {
    // senderId confirmed as the chatId field in OpenClaw 2026.3.22
    const chatId =
      cmdCtx?.senderId ??
      cmdCtx?.chatId ??
      cmdCtx?.chat?.id ??
      cmdCtx?.from?.id ??
      cmdCtx?.accountId;
    if (chatId && String(chatId) !== "default") {
      lastChatId = String(chatId);
      logger.info(`[bee-push-email] Captured chatId: ${lastChatId}`);
    }
    return {
      args,
      imap: imapService,
      rulesFile: rulesFile ?? { version: "1" as const, default_action: { type: "notify" as const }, rules: [] },
      rulesPath,
      onRulesChanged: (updated: RulesFile) => { rulesFile = updated; },
    };
  };

  api.registerCommand({
    name: "beemail",
    description: "Email watcher status",
    handler: (ctx: any) => cmdStatus(getCtx("", ctx)),
  });

  api.registerCommand({
    name: "beemail_rules",
    description: "List email rules",
    handler: (ctx: any) => cmdRulesList(getCtx("", ctx)),
  });

  api.registerCommand({
    name: "beemail_rule_toggle",
    description: "Enable or disable a rule",
    acceptsArgs: true,
    handler: async (ctx: any) =>
      cmdRuleToggle({ ...getCtx(ctx.args, ctx) }),
  });

  api.registerCommand({
    name: "beemail_rule_delete",
    description: "Delete a rule",
    acceptsArgs: true,
    handler: async (ctx: any) =>
      cmdRuleDelete({ ...getCtx(ctx.args, ctx) }),
  });

  api.registerCommand({
    name: "beemail_rule_test",
    description: "Test a rule against the last received email",
    acceptsArgs: true,
    handler: (ctx: any) =>
      cmdRuleTest({ ...getCtx(ctx.args, ctx) }, lastEmail),
  });

  // /beemail_install — redirects to the SKILL.md-driven wizard.
  // The conversational wizard lives in SKILL.md (Guided installation section).
  // The plugin command just tells the user how to trigger it naturally so the
  // agent loads the SKILL.md and follows the step-by-step flow with full context.
  api.registerCommand({
    name: "beemail_install",
    description: "Guided first-time setup wizard",
    handler: () => ({
      text: [
        "🐝 **bee-push-email setup**",
        "",
        "To start the guided setup, say:",
        "> **set up bee-push-email**",
        "",
        "I'll walk you through IMAP server, email, password, and all other settings one step at a time.",
      ].join("\n"),
    }),
  });

  // /beemail_reconfigure — same approach: show current config, redirect to natural language.
  api.registerCommand({
    name: "beemail_reconfigure",
    description: "Update configuration interactively",
    handler: () => {
      const host = pluginConfig?.imap.host || "not set";
      const email = pluginConfig?.imap.email || "not set";
      const folder = pluginConfig?.imap.folder || "INBOX";
      const mode = pluginConfig?.auto_reply_mode || "false";
      return {
        text: [
          "🐝 **bee-push-email — current config**",
          "",
          `• Host: ${host}`,
          `• Email: ${email}`,
          `• Password: ${pluginConfig?.imap.password ? "****" : "not set"}`,
          `• Port: ${pluginConfig?.imap.port ?? 993}  |  SSL: ${pluginConfig?.imap.ssl ? "yes" : "no"}`,
          `• Folder: ${folder}`,
          `• Auto-reply: ${mode}`,
          `• Rules file: ${pluginConfig?.rules_file ?? "bee-push-email-rules.json"}`,
          "",
          "To change any field, say:",
          "> **reconfigure bee-push-email** or **change my email password** or **update IMAP host**",
        ].join("\n"),
      };
    },
  });

  // /beemail_rule_add — redirect to natural language so SKILL.md drives the flow.
  api.registerCommand({
    name: "beemail_rule_add",
    description: "Add a new email rule (guided)",
    handler: () => ({
      text: [
        "🐝 **Add an email rule**",
        "",
        "Tell me what you want to do, for example:",
        "> **\"Silence all emails from GitHub\"**",
        "> **\"Notify me when I get emails from my boss\"**",
        "> **\"Move newsletters to a folder automatically\"**",
        "",
        "I'll build the rule from your description.",
      ].join("\n"),
    }),
  });

  api.registerCommand({
    name: "beemail_notif_on",
    description: "Enable email notifications (default action: notify)",
    handler: () => cmdNotifOn(getCtx()),
  });

  api.registerCommand({
    name: "beemail_notif_off",
    description: "Disable email notifications (default action: silence)",
    handler: () => cmdNotifOff(getCtx()),
  });

  // /beemail_reply_off / _ask / _on — change global reply mode
  for (const [cmd, mode, label] of [
    ["beemail_reply_off", "false", "🔒 Auto-reply DISABLED"],
    ["beemail_reply_ask", "ask",   "❓ Auto-reply set to ASK"],
    ["beemail_reply_on",  "true",  "⚠️  Auto-reply ENABLED"],
  ] as const) {
    const m = mode, l = label;
    api.registerCommand({
      name: cmd,
      description: `Set auto-reply mode to ${m}`,
      handler: () => {
        if (!pluginConfig) return { text: "Plugin not initialized." };
        pluginConfig = { ...pluginConfig, auto_reply_mode: m };
        if (m === "true") {
          return { text: `${l}\n⚠️ This exposes that the system is active to all senders.` };
        }
        return { text: l };
      },
    });
  }

  logger.info("[bee-push-email] Plugin registered successfully");
}
