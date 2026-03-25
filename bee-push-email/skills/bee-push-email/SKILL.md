---
name: bee-push-email
description: Real-time IMAP IDLE email push notifications with rule engine. Detects new emails instantly and triggers the OpenClaw agent to process them. Supports flexible rules to notify, silence, move, reply, or run agent commands per email. Use when: managing email push notifications, adding or editing email rules, checking watcher status, testing rules, changing auto-reply mode, setting up or reconfiguring email. Triggers on commands: /beemail, /beemail_rules, /beemail_rule_add, /beemail_rule_toggle, /beemail_rule_delete, /beemail_rule_test, /beemail_install, /beemail_reconfigure, /beemail_reply_off, /beemail_reply_ask, /beemail_reply_on. Also load this skill when the user says: "set up bee-push-email", "configure email notifications", "install email push", "reconfigure bee-push-email", "change my email password", "update IMAP", "add an email rule", "silence emails from".
emoji: 📬
requirements:
  bins:
    - node
---

# bee-push-email

Real-time email push via IMAP IDLE. Detects new emails and applies configurable rules — notify, silence, move, reply, or trigger agent commands.

## Rule engine

Rules are evaluated in order. The first matching rule runs its actions (unless `stop_on_match: false`). If no rule matches, the default action runs (default: notify).

### Managing rules from Telegram

| Command | What it does |
|---|---|
| `/beemail_rules` | List all rules with status |
| `/beemail_rule_add` | Guided rule creation (agent helps you build it) |
| `/beemail_rule_toggle <id>` | Enable or disable a rule |
| `/beemail_rule_delete <id>` | Delete a rule |
| `/beemail_rule_test <id>` | Test rule against last received email |

### Rule file: `bee-push-email-rules.json`

Located in the OpenClaw workspace. Edit manually or via Telegram commands.

```json
{
  "version": "1",
  "default_action": { "type": "notify" },
  "rules": [
    {
      "id": "rule_abc123",
      "name": "GitHub notifications",
      "enabled": true,
      "stop_on_match": true,
      "match": {
        "field": "from_domain",
        "op": "equals",
        "value": "github.com"
      },
      "actions": [
        { "type": "mark_read" },
        { "type": "move", "folder": "Automated/GitHub" }
      ]
    }
  ]
}
```

### Available match fields
`from`, `from_domain`, `to`, `subject`, `folder`, `body_preview`

### Available match operators
`equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `matches` (regex)

### Compound conditions
```json
{ "operator": "AND", "conditions": [
  { "field": "from_domain", "op": "equals", "value": "wordfence.com" },
  { "field": "subject", "op": "contains", "value": "alert" }
]}
```

### Available actions

| Type | Description | Extra fields |
|---|---|---|
| `notify` | Send notification to user | `template` (optional, supports `{from}`, `{subject}`, `{folder}`, `{uid}`) |
| `silence` | Ignore email completely | — |
| `move` | Move to IMAP folder | `folder` (required) |
| `mark_read` | Mark as read | — |
| `mark_unread` | Mark as unread | — |
| `reply` | Auto-reply | `body` (optional) — requires `auto_reply_mode: true` |
| `ask_reply` | Ask user for approval before replying | `prompt` (optional template) |
| `agent_command` | Trigger agent with custom instructions | `message` (required, supports template vars) |
| `forward` | Forward notification to another channel | `channel` + `target` (required) |

## Auto-reply mode

| Command | Mode | Behaviour |
|---|---|---|
| `/beemail_reply_off` | `false` (default) | Never replies to senders |
| `/beemail_reply_ask` | `ask` | Asks user for approval first |
| `/beemail_reply_on` | `true` | Agent decides whether to reply |


## Guided installation

When a user asks to install or set up bee-push-email, run the guided wizard:

**Trigger phrases:** "install bee-push-email", "set up email push", "configure email notifications", "beemail setup"

Follow this exact flow — ask ONE question at a time, wait for the answer, then proceed:

### Step 1 — IMAP server hostname

Ask:
> "What is your IMAP server address?
>
> This is your email provider's incoming mail server. You can find it in your email client settings or your provider's help docs.
>
> Common values:
> • Gmail → **imap.gmail.com**
> • Outlook / Office 365 → **outlook.office365.com**
> • Yahoo → **imap.mail.yahoo.com**
> • Self-hosted → **mail.yourdomain.com**
>
> Enter the hostname:"

### Step 2 — Port and SSL

Ask:
> "Which port should I use? (Default: **993** with SSL — recommended)
>
> • **993** — encrypted SSL/TLS connection (safest, works with most providers)
> • **143** — unencrypted or STARTTLS (only if your provider requires it)
>
> Press Enter to use 993, or type a different port:"

If they choose 993 or leave blank, set ssl: true. If they choose 143, ask if they want STARTTLS.

### Step 3 — Email address

Ask:
> "What is the email address to monitor?
>
> This is your full email address (e.g. **you@gmail.com**). It is used as both the login username and to identify the inbox."

### Step 4 — Password

Ask:
> "What is the password for this account?
>
> ⚠️ If you have two-factor authentication enabled, you **must** use an app-specific password instead of your main password. App passwords are more secure and will not break if you change your main password.
>
> How to create one:
> • **Gmail** → myaccount.google.com → Security → App passwords
> • **Outlook** → account.microsoft.com → Security → App passwords
> • **Yahoo** → account.yahoo.com → Security → Generate app password
>
> Enter your password or app-specific password:"

Do not echo the password back in plaintext in any message.

### Step 5 — Folder

Ask:
> "Which folder should I monitor? (Default: **INBOX**)
>
> INBOX works for most setups. If you want to watch a specific folder:
> • Work emails filtered to a label → e.g. **Work**
> • Gmail label → e.g. **[Gmail]/Important**
> • Nested folder → e.g. **Projects/Client-A**
>
> Press Enter for INBOX, or type a folder name:"

### Step 6 — Auto-reply mode

Ask:
> "Should the agent be able to reply to emails on your behalf? (Default: **no — never reply**)
>
> • **no / false** *(recommended)* — I will only notify you via Telegram. I will never send a reply to any sender. This is the safest option.
> • **ask** — I will notify you AND ask for your explicit yes/no approval before sending any reply. You stay in control.
> • **yes / true** — I may reply automatically based on email content and rules. ⚠️ Use with caution: this reveals that an AI agent is active and may accidentally reply to spam or phishing emails.
>
> Enter no, ask, or yes (default: no):"

### Step 7 — Rules file

Ask:
> "Where should I store your email rules? (Default: **bee-push-email-rules.json** in your workspace)
>
> Rules define what happens when specific emails arrive — notify, silence, move to folder, auto-reply, or run custom agent commands. You manage them with /beemail_rule_add later.
>
> Press Enter to use the default location, or enter a custom path:"

### Step 8 — Summary and confirmation

Show:
> "✅ Here's the configuration I'll save:
>
> • IMAP server: [host]:[port] (SSL: yes/no)
> • Email: [email]
> • Password: ****
> • Folder: [folder]
> • Auto-reply: [mode]
> • Rules file: [path]
>
> Shall I save this to your openclaw.json and restart the Gateway? (yes/no)"

Only proceed if the user confirms.

### Step 9 — Save and restart

Write the config block to openclaw.json under `plugins.entries.bee-push-email.config`, then run:
```bash
openclaw gateway restart
```

Then tell the user:
> "✅ bee-push-email is now active. Send yourself a test email to verify everything is working.
>
> Use /beemail_rule_add to set up rules for specific senders or subjects."


## Configuration (openclaw.json)

Config fields are **flat** — directly under `plugins.entries.bee-push-email.config`, NOT nested under `"imap"`.

```json
{
  "plugins": {
    "allow": ["bee-push-email"],
    "entries": {
      "bee-push-email": {
        "enabled": true,
        "config": {
          "host": "imap.example.com",
          "port": 993,
          "ssl": true,
          "email": "you@example.com",
          "password": "app-password",
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
