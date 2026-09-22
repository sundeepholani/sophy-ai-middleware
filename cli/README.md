# Sophy CLI

Manage Sophy projects, API keys, evaluations, knowledgebases, members, usage, logs, and settings from a terminal. The server applies the same project roles and ownership rules as the web console.

## Install

Use Node.js 22 or later. From this repository, run:

```sh
npm install -g ./cli
sophy --help
```

This package has no external dependencies. Installation uses this local source directory. This change does not publish an npm package.

For a temporary local installation without global permissions, run:

```sh
npm install --prefix /tmp/sophy-cli-install ./cli
/tmp/sophy-cli-install/node_modules/.bin/sophy --help
```

## Sign in with an email code

```sh
sophy login --email person@example.com
```

Enter the six-digit code from your email at the hidden prompt. The code expires after 10 minutes and works once. After five incorrect attempts, request a new code.

A bare `sophy login` also prompts for your email. The CLI never prints the session token. It does not accept an OTP as a command-line argument.

For a separate request and verification, run:

```sh
sophy auth request --email person@example.com
sophy auth verify
```

`auth verify` uses the challenge saved by the previous request. For noninteractive use, supply only the code on standard input. A secret manager can provide that input without a literal code in shell history.

If a code is invalid or expired, request a new code. If the server limits sign-in attempts, wait a few minutes before another request.

Inspect your current account or revoke this CLI session:

```sh
sophy whoami
sophy logout
```

`logout` revokes the session on the server before it removes the local token. If the server is unavailable, the command retains the token for another attempt.

A new sign-in saves the replacement session before it revokes the previous session. If that revocation fails, the CLI retains it for a later `logout` attempt. The new session remains available.

## Select a project

```sh
sophy projects list
sophy projects use <project-id>
sophy keys list
```

`projects use` confirms your current access before it saves a local default. This selection applies only to this CLI account and server.

To use another project for one command, supply `--project`:

```sh
sophy keys list --project <project-id>
```

The project selection order is `--project`, `SOPHY_PROJECT`, then the saved local default. The CLI requires a project for all project commands, including `models`.

To change the default project in the web console, run:

```sh
sophy projects default --project <project-id>
```

## Create and manage API keys

Create a key with a name and model:

```sh
sophy keys create --name "Support" --model openai/gpt-4.1
```

The response contains the full key once. Store this key securely. A later `keys get` returns its configuration, not its full secret.

For complete configuration, create a JSON file:

```json
{
  "name": "Support",
  "model": "openai/gpt-4.1",
  "systemPrompt": "Answer questions using the support guide.",
  "params": {
    "temperature": 0.2,
    "maxOutputTokens": 1000,
    "allowClientPrompt": false
  },
  "outputSchema": null,
  "monthlyCostCapUsd": 100,
  "rpmLimit": 60,
  "logContent": false,
  "ownerUserId": null,
  "knowledgebaseId": null
}
```

Then supply the file:

```sh
sophy keys create --data @key.json
sophy keys get <key-id>
sophy keys update <key-id> --data @changes.json
```

An update preserves fields that you omit. A supplied `params` object replaces all existing parameters. A JSON `null` clears an optional value. An admin can set a `null` monthly budget for unlimited spending.

Editors automatically own the keys they create. The server restricts ownership changes and budget changes to project admins.

Rotate or revoke a key:

```sh
sophy keys rotate <key-id>
sophy keys revoke <key-id>
```

These commands require confirmation. Rotation immediately invalidates the previous secret. The rotation response contains the replacement secret once.

For scripts, review the target before you supply `--yes`:

```sh
sophy keys rotate <key-id> --yes --json
```

## Evaluations and bulk changes

```sh
sophy evals start <key-id> --challenger-model openai/gpt-4.1-mini --target-n 100
sophy evals list
sophy evals get <run-id>
sophy evals refresh <key-id>
sophy evals cancel <run-id>
```

Bulk commands accept an explicit list of key IDs:

```sh
sophy keys bulk-model --data @model-change.json
sophy evals bulk-start --data @evaluation.json
```

Example `model-change.json`:

```json
{
  "ids": ["<key-id-1>", "<key-id-2>"],
  "model": "openai/gpt-4.1-mini"
}
```

Example `evaluation.json`:

```json
{
  "ids": ["<key-id-1>", "<key-id-2>"],
  "challengerModel": "openai/gpt-4.1-mini",
  "targetN": 100
}
```

A model change can require an active evaluation to stop. For one key, explicitly supply `stopRunningEval: true` after you review that requirement. For bulk commands, `stopEvalIds` identifies the exact keys whose evaluations can stop.

Stopping an evaluation removes its captured samples. The CLI requires confirmation for these inputs. `--yes` confirms the supplied input but never adds evaluation IDs automatically.

## Other console commands

Each command accepts `--help` for its input fields. IDs shown as arguments can also appear in `--data`.

| Area | Commands |
| --- | --- |
| Projects | `projects list`, `create`, `rename`, `default`, `recover`, `use` |
| Gateway | `gateway status`, `connect`, `disconnect` |
| API keys | `keys list`, `get`, `create`, `update`, `rotate`, `revoke`, `bulk-model` |
| Evaluations | `evals list`, `get`, `start`, `bulk-start`, `cancel`, `refresh` |
| Reporting | `overview`, `models`, `usage`, `logs list`, `logs get` |
| Knowledgebases | `knowledgebases list`, `options`, `create`, `delete`, `documents`, `upload`, `document-delete`, `document-retry` |
| Members | `members list`, `invite`, `role`, `status`, `remove` |
| Invitations | `invitations list`, `role`, `resend`, `revoke` |
| Settings | `settings get`, `settings update` |

Examples:

```sh
sophy projects create --name "Customer Support"
sophy projects rename --name "Support Production"
sophy gateway status
sophy gateway connect --data @gateway.json
sophy usage --since-days 30
sophy usage --since-days 7 --key-id <key-id>
sophy logs list --source proxy --limit 50
sophy logs get <log-id>
sophy knowledgebases create --name "Support Guide"
sophy knowledgebases upload <knowledgebase-id> --file ./guide.pdf
sophy knowledgebases documents <knowledgebase-id>
sophy knowledgebases document-retry <document-id>
sophy members invite --email editor@example.com --role editor
sophy members role <user-id> --role admin
sophy members status <user-id> --active false
sophy invitations resend <invitation-id>
sophy settings get
sophy settings update --judge-model openai/gpt-4.1 --notify-email alerts@example.com
```

The gateway JSON file contains `{"apiKey":"<gateway-secret>"}`. The CLI accepts this secret only through `--data @file` or `--data -`. It rejects inline secrets and a `--api-key` flag.

Document uploads support text, Markdown, CSV, JSON, PDF, and Word (`.docx`). Each file must be nonempty and no larger than 4 MB.

The usage range supports 7, 30, or 90 days. Log sources are `proxy`, `processor`, `challenger`, `judge`, and `kb`. Log lists return up to 100 entries.

## JSON input and output

All management commands return JSON. `--json` selects compact output. Prompts and errors use standard error, so standard output remains suitable for scripts.

Use `--data` for nested input:

- `--data @file.json` reads a JSON object from a file.
- `--data -` reads a JSON object from standard input.
- `--data '{"name":"Example"}'` accepts inline JSON for values that are not secrets.

Named flags use kebab case, such as `--monthly-cost-cap-usd`. JSON fields use camel case, such as `monthlyCostCapUsd`. Boolean flags accept `true` or `false`. Nullable flags accept the literal `null`.

An input field can appear once, through an argument, a flag, or JSON. Unknown input fields stop the command before the request.

| Exit code | Meaning |
| --- | --- |
| `0` | The request succeeded. |
| `1` | Input, authentication, permission, connection, or server error. |
| `2` | A bulk action skipped items, or a key update needs evaluation-stop confirmation. |

Exit code `2` preserves the server result on standard output. That result identifies the incomplete work.

## Servers and session storage

The default server is `https://sophy.in`. For another deployment, supply the same `--url` for sign-in and subsequent commands:

```sh
sophy login --url https://sophy.example.com --email person@example.com
sophy projects list --url https://sophy.example.com
```

`SOPHY_URL` sets the default server for a shell or script. The CLI requires HTTPS, except for `localhost`, `127.0.0.1`, and `[::1]` development servers. Requests never follow redirects.

Each server origin has a separate session, OTP challenge, and local default project. A token saved for one origin never authenticates a request to another origin.

Concurrent commands preserve changes for other origins. Local storage updates use a lock with a five-second timeout. The CLI recovers locks abandoned by an exited process. A stale command cannot overwrite a newer session or restore a session after logout.

The CLI stores tokens in `~/.config/sophy/config.json`. If `XDG_CONFIG_HOME` is set, the CLI uses that directory instead of `~/.config`. `SOPHY_CONFIG_DIR` selects a dedicated storage directory. This file contains readable secrets protected by operating-system file permissions. It does not use an operating-system keychain.

The storage directory uses mode `0700`. The file uses mode `0600`. The CLI rejects symbolic links for its directory and session file.

The server verifies the active account, session expiry, project membership, role, and resource ownership for each command. Console access changes therefore apply to CLI requests too. A Sophy API key cannot replace a CLI session token.

## Development checks

```sh
npm test --prefix cli
npm pack ./cli --dry-run
```

The tests use local fake HTTP servers and synthetic credentials. They cover authentication, access-error handling, origin isolation, redirect rejection, input mapping, uploads, confirmations, concurrent session updates, revocation retries, and logout.
