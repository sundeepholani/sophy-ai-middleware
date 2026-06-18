# Migrating to Sophy

Sophy is your organization's central AI gateway. Instead of calling OpenAI or
Anthropic directly with your own provider key, you call **Sophy** with a key it
issues. The **model, system prompt, and limits are configured on your key** by
the platform operator — so you don't hardcode them anymore, and they can be
changed centrally without you redeploying.

Sophy speaks the **OpenAI API** (both Chat Completions and the Responses API).

---

## TL;DR

| You currently use… | What to do |
|---|---|
| **OpenAI SDK** (Chat Completions) | Change `base_url` + `api_key`. Keep your code. |
| **OpenAI SDK** (Responses API) | Change `base_url` + `api_key`. Keep your code. |
| **Anthropic / Claude SDK** | Switch to the **OpenAI SDK** pointed at Sophy (examples below). You still get Claude — your key is set to a Claude model. |

- **Base URL:** `https://sophy.in/v1`
- **API key:** a `mw_live_…` key issued to you (ask the operator; created at `https://sophy.in/admin`)
- **Stop sending** `model`, `system` / `instructions`, and generation params — they're owned by your key and ignored if sent.

---

## 1. Get your key

Ask the operator for a Sophy API key. It looks like `mw_live_xxxxxxxx…`. Tied to
that key, the operator has set:
- the **model** (e.g. an OpenAI or Anthropic/Claude model),
- the **system prompt**,
- optional **params** (temperature, max tokens) and an **output JSON schema**,
- your **quota / rate limit**.

Store it like any secret (e.g. `SOPHY_API_KEY` env var).

---

## 2. If you use the OpenAI SDK

Change only `base_url` and `api_key`. Everything else stays.

### Chat Completions

```python
# Python
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["SOPHY_API_KEY"],   # was OPENAI_API_KEY
    base_url="https://sophy.in/v1",          # new
)
resp = client.chat.completions.create(
    model="sophy",                           # ignored — your key sets the model
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

```ts
// Node / TypeScript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SOPHY_API_KEY,
  baseURL: "https://sophy.in/v1",
});
const resp = await client.chat.completions.create({
  model: "sophy",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(resp.choices[0].message.content);
```

### Responses API

```python
client = OpenAI(api_key=os.environ["SOPHY_API_KEY"], base_url="https://sophy.in/v1")
resp = client.responses.create(model="sophy", input="Hello")
print(resp.output_text)
```

Streaming works unchanged (`stream=True`).

---

## 3. If you use the Anthropic (Claude) SDK

Sophy uses the OpenAI protocol, so the Anthropic SDK can't talk to it directly —
**switch to the OpenAI SDK** pointed at Sophy. You keep using Claude: the
operator sets your key to a Claude model, and Sophy routes there. Your code gets
*simpler* (no `system`/`max_tokens`/`model` to manage).

Install the OpenAI SDK: `pip install openai` (Python) or `npm i openai` (Node).

```python
# BEFORE — Anthropic SDK
from anthropic import Anthropic
client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
msg = client.messages.create(
    model="claude-3-7-sonnet-latest",
    max_tokens=1024,
    system="You are a support assistant.",
    messages=[{"role": "user", "content": "How do I reset my password?"}],
)
print(msg.content[0].text)

# AFTER — OpenAI SDK → Sophy (still runs on Claude, set on your key)
from openai import OpenAI
client = OpenAI(
    api_key=os.environ["SOPHY_API_KEY"],
    base_url="https://sophy.in/v1",
)
resp = client.chat.completions.create(
    model="sophy",                                   # ignored; key is set to your Claude model
    messages=[{"role": "user", "content": "How do I reset my password?"}],
)
print(resp.choices[0].message.content)
```

```ts
// Node: replace @anthropic-ai/sdk with openai
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.SOPHY_API_KEY, baseURL: "https://sophy.in/v1" });
const resp = await client.chat.completions.create({
  model: "sophy",
  messages: [{ role: "user", content: "How do I reset my password?" }],
});
console.log(resp.choices[0].message.content);
```

### Anthropic → OpenAI field mapping

| Anthropic | OpenAI / Sophy |
|---|---|
| `client.messages.create(...)` | `client.chat.completions.create(...)` |
| `system="..."` (top-level) | **remove** — your key's system prompt is used |
| `max_tokens=...` (required by Anthropic) | **remove** — owned by the key |
| `model="claude-…"` | **remove / ignored** — the key is pointed at a Claude model |
| `messages=[{role, content}]` | same shape (`user`/`assistant`, text content) |
| `msg.content[0].text` | `resp.choices[0].message.content` |
| `client.messages.stream(...)` | `client.chat.completions.create(..., stream=True)`, read `chunk.choices[0].delta.content` |
| tool use | not supported (returns HTTP 400) |

---

## 4. What changes for everyone

Because your key owns the configuration, these request fields are **silently
ignored** if you send them (no error):
- `model` — your key's model is always used.
- `system` messages / Responses `instructions` — your key's system prompt is used. **Delete any hardcoded system prompt.**
- `temperature`, `max_tokens` / `max_output_tokens`, `top_p` — owned by the key.

Other behavior:
- **Tool / function calling is not supported** → returns HTTP `400`. Tell the operator if you need it.
- **Structured JSON output** is configured on your key (not per request). When enabled, the reply text is a JSON string — parse `resp.choices[0].message.content` (or `resp.output_text`).
- **Streaming** is unchanged (`stream=True`).
- **Files:** don't inline large files in the request. Upload to `POST https://sophy.in/v1/files` (multipart, ≤ 4 MB) and pass the returned URL as a content part.
- **Errors** use the standard OpenAI error shape and HTTP codes: `401` invalid key, `402` quota exceeded, `429` rate limited, `400` bad request.

---

## 5. Test it

```bash
curl https://sophy.in/v1/chat/completions \
  -H "Authorization: Bearer $SOPHY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi"}]}'
```

A `200` with a `choices[0].message.content` means you're done.

---

## FAQ

**Which model am I using?** Whatever the operator set on your key (OpenAI or
Claude/etc.). Call `GET https://sophy.in/v1/models` with your key to see it.

**I need a different system prompt / model than my key has.** Ask the operator to
adjust your key (or issue you another). Changes apply on your next request — no
redeploy on your side.

**Will my old `model`/`system`/`temperature` break anything?** No — they're
ignored, not rejected (except `tools`, which returns 400). Cleanest is to remove
them.

**Do I need a different base URL for Chat Completions vs Responses?** No. Same
base URL (`https://sophy.in/v1`); the SDK calls the right endpoint based on the
method (`.chat.completions.create()` vs `.responses.create()`).
