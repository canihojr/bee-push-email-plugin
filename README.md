[README.md](https://github.com/user-attachments/files/26251332/README.md)
# 🐝 bee-push-email v2.7.4 — OpenClaw Plugin

Real-time IMAP IDLE email push notifications for OpenClaw with a flexible rule engine.

---

## What can bee-push-email do?

**Q: How quickly does it notify me when a new email arrives?**
Using IMAP IDLE, the plugin detects new emails within ~1 second of arrival. It runs as a background service inside the OpenClaw Gateway — no polling, no subprocess, no delay.

**Q: Do I need to leave something open for it to work?**
No. The plugin runs as part of the OpenClaw Gateway daemon, which stays running on your machine at all times. As long as the Gateway is running, email monitoring is active.

**Q: Can I silence specific types of emails without being notified?**
Yes. Create a rule with the `silence` action. For example: mark all GitHub notification emails as read and move them to a folder silently — but still catch emails from GitHub where the subject contains "security alert" and notify those immediately.

**Q: Can it reply to emails automatically?**
Yes, with three modes: `false` (never reply — default), `ask` (asks your approval before each reply), or `true` (agent composes and sends replies based on your rules). Toggle at any time with `/beemail_reply_off`, `/beemail_reply_ask`, or `/beemail_reply_on`.

**Q: Can I define rules that trigger custom agent actions?**
Yes. The `agent_command` action lets you write a natural language instruction that runs whenever a matching email arrives. For example: "When an invoice arrives from any supplier, extract the amount and due date and save them to my expenses tracker."

**Q: How do I create rules? Do I need to edit JSON manually?**
Use `/beemail_rule_add` from Telegram — the agent guides you through creating a rule interactively. You can also edit `bee-push-email-rules.json` directly in your workspace if you prefer.

**Q: Can I filter by sender, domain, subject, or email body?**
Yes. Rules match on `from`, `from_domain`, `to`, `subject`, `folder`, and `body_preview`. Conditions combine with AND, OR, and NOT logic.

**Q: What happens if my internet connection drops?**
The plugin reconnects automatically with exponential backoff (10s → 20s → 40s → up to 5 min). On reconnect it fetches any emails missed while disconnected before re-entering IDLE.

**Q: Will it flood me with notifications on first install?**
No. On first install the plugin initializes to the current mailbox position and only notifies about emails that arrive after installation.

**Q: Is my email password stored securely?**
The password lives in `openclaw.json`. Use an app-specific password (not your main password) and `chmod 600 ~/.openclaw/openclaw.json`. App password setup for Gmail, Outlook, and Yahoo is covered in the guided wizard.

**Q: Can I test a rule before activating it?**
Yes. `/beemail_rule_test <rule_id>` tests any rule against the last email received in the current session and shows whether it would match and which actions would run.

---

## Architecture

Native OpenClaw Plugin (TypeScript, runs in-process with the Gateway):

- `registerService` — persistent IMAP IDLE connection inside the Gateway process
- `enqueueSystemEvent` — true push (~1s latency, wakes the agent immediately)
- `registerCommand` — direct Telegram commands, no LLM overhead for status queries
- Bundled `SKILL.md` — agent instructions shipped with the plugin

---

## Installation

### Option A — via OpenClaw CLI (recommended)

```bash
openclaw plugins install clawhub:bee-push-email
```

This copies the plugin to `~/.openclaw/extensions/bee-push-email/`, installs npm
dependencies, and registers it in your config automatically.

### Option B — manual install from zip

```bash
# 1. Extract the zip into the extensions directory
unzip bee-push-email-plugin-v2.7.4.zip -d /tmp/
cp -r /tmp/bee-push-email ~/.openclaw/extensions/bee-push-email

# 2. Install npm dependencies (required — the plugin needs imapflow and zod)
cd ~/.openclaw/extensions/bee-push-email
npm install --ignore-scripts

# 3. Add the plugin to openclaw.json (see config below)

# 4. Restart the Gateway
openclaw gateway restart
```

> **Why `npm install`?** The plugin uses `imapflow` (IMAP IDLE library) and `zod`
> (config validation). These are not bundled in the zip — they must be installed
> separately. Without this step the Gateway logs `Cannot find module 'imapflow'`
> and the plugin fails to load.

### Minimum config for openclaw.json

Add this block to start the Gateway immediately after install, before running
the guided setup. All IMAP fields are empty — the plugin loads cleanly and
waits for `/beemail_install`.

```json
{
  "plugins": {
    "allow": ["bee-push-email"],
    "entries": {
      "bee-push-email": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

Then restart:

```bash
openclaw gateway restart
```

Send `/beemail_install` to your agent — it will walk you through the full setup.

### Full config example (after running `/beemail_install`)

```json
{
  "plugins": {
    "allow": ["bee-push-email"],
    "entries": {
      "bee-push-email": {
        "enabled": true,
        "config": {
          "host": "imap.gmail.com",
          "port": 993,
          "ssl": true,
          "email": "you@gmail.com",
          "password": "abcd efgh ijkl mnop",
          "folder": "INBOX",
          "preferred_channel": "telegram",
          "rules_file": "bee-push-email-rules.json",
          "auto_reply_mode": "false"
        }
      }
    }
  }
}
```

**Common IMAP hostnames:**

| Provider | Host |
|---|---|
| Gmail | `imap.gmail.com` |
| Outlook / Office 365 | `outlook.office365.com` |
| Yahoo | `imap.mail.yahoo.com` |
| Self-hosted | `mail.yourdomain.com` |

**App-specific passwords** (recommended over your main password):
- Gmail → myaccount.google.com → Security → App passwords
- Outlook → account.microsoft.com → Security → App passwords
- Yahoo → account.yahoo.com → Security → Generate app password

After saving config, always restart the Gateway:

```bash
openclaw gateway restart
```

---

## Guided setup

After the Gateway is running with the minimum config above, send this to your agent:

> `/beemail_install`

The agent walks you through each setting one at a time, then writes the completed
config to `openclaw.json` and restarts the Gateway automatically.

To update an existing config later: `/beemail_reconfigure`

---

## Rules

Copy `bee-push-email-rules.example.json` to your workspace as
`bee-push-email-rules.json` and customize, or use `/beemail_rule_add` from
Telegram to create rules interactively. Full schema reference in
`skills/bee-push-email/SKILL.md`.

---

## Telegram commands

| Command | Description |
|---|---|
| `/beemail` | Status: connection + rule count |
| `/beemail_install` | First-time guided setup wizard |
| `/beemail_reconfigure` | Update existing config interactively |
| `/beemail_rules` | List all rules |
| `/beemail_rule_add` | Add a rule (agent-guided) |
| `/beemail_rule_toggle <id>` | Enable or disable a rule |
| `/beemail_rule_delete <id>` | Delete a rule |
| `/beemail_rule_test <id>` | Test rule against last email |
| `/beemail_reply_off` | Disable auto-reply (default) |
| `/beemail_reply_ask` | Require approval before replying |
| `/beemail_reply_on` | Enable auto-reply |

---

## Troubleshooting

**`Cannot find module 'imapflow'`**
The plugin was copied manually without installing dependencies. Fix:
```bash
rm -rf ~/.openclaw/extensions/bee-push-email
openclaw plugins install ./bee-push-email-plugin-v2.7.4.zip
```

**`plugins.allow: plugin not found: bee-push-email`**
The plugin must be in `~/.openclaw/extensions/bee-push-email/`. If it ended up
in `~/.openclaw/plugins/`, remove it and reinstall:
```bash
rm -rf ~/.openclaw/plugins/bee-push-email
openclaw plugins install ./bee-push-email-plugin-v2.7.4.zip
```

**Provenance warning on every Gateway start**
(`loaded without install/load-path provenance`)
The plugin was copied manually instead of installed via the CLI. Reinstall properly:
```bash
rm -rf ~/.openclaw/extensions/bee-push-email
openclaw plugins install ./bee-push-email-plugin-v2.7.4.zip
```

**Plugin logs appear twice**
Two copies of the plugin exist (`~/.openclaw/plugins/` and `~/.openclaw/extensions/`).
Remove both and reinstall:
```bash
rm -rf ~/.openclaw/plugins/bee-push-email ~/.openclaw/extensions/bee-push-email
openclaw plugins install ./bee-push-email-plugin-v2.7.4.zip
```

**`must have required property 'host'`**
You are running an old version of the plugin (pre-2.7.0) that required `host`,
`email`, and `password` to be present. Update to v2.7.4 and use `"config": {}`
for a fresh install.

**Gateway starts but `/beemail` shows `⚙️ Not configured`**
Expected — this means the plugin loaded successfully but IMAP credentials are
not set yet. Send `/beemail_install` to complete setup.

---

## Migration from v1.x (Python watcher)

1. Stop the old watcher: `bash uninstall.sh --yes`
2. Install the plugin and run the guided setup: `/beemail_install`
3. Copy or recreate your rules in `bee-push-email-rules.json`
4. `openclaw gateway restart`

The `gateway token missing` issue from v1.x is resolved — the plugin runs
in-process with the Gateway and requires no separate authentication.

---

## Development

```bash
npm install
npx tsc --noEmit   # type-check
npx tsdown src/index.ts --format esm --dts   # build
```

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md)
