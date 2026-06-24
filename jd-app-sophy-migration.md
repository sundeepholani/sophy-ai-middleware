# Task: Make the JD‑Creation App Robust to Sophy's Structured JSON Responses

## Why you are doing this (read first)

This app generates **job descriptions** by calling an LLM through **Sophy**, an
OpenAI‑compatible AI gateway. The app authenticates with a Sophy API key (looks
like `mw_live_…`) and talks to Sophy exactly like the OpenAI API (a `base_url`
pointing at Sophy + the key).

We are about to turn on **strict structured output** on the Sophy side. After
that change, the model's replies will be **guaranteed‑valid JSON** — newlines
properly escaped, and **never** wrapped in a Markdown code fence.

**Today the replies are often *invalid* JSON** (multi‑line strings with raw,
unescaped newlines) and are **inconsistently wrapped in ```` ```json ```` fences**.
That means this app is almost certainly parsing replies with fragile, ad‑hoc
logic (fence stripping, string slicing, line splitting, lenient/`try` parsing).
**When Sophy starts sending clean, valid, un‑fenced JSON, that fragile logic will
break — even though the responses are objectively *better*.**

**Your job: update this app's response handling so it parses Sophy's replies
robustly and correctly, and works for BOTH the current (messy) and the future
(clean) formats. This must ship *before* the Sophy schema is enabled.** Do not
change anything about the model, the prompt, or the Sophy configuration — only
this app.

---

## How the app talks to Sophy (find this in the code)

The app sends a **multi‑turn chat**: every turn it sends the **full conversation
so far** (system/user/assistant messages) to Sophy and gets back **one assistant
message**. (Sophy is stateless — the app already re‑sends history each turn; keep
doing that.)

The assistant message's **text content is a JSON string**. Where you read it
depends on which OpenAI API the app uses:

- **Chat Completions** (`/v1/chat/completions`): `response.choices[0].message.content`
- **Responses API** (`/v1/responses`): `response.output_text` (or walk
  `response.output[].content[].text`)

Locate wherever the app currently extracts and interprets that content — that is
the code you will replace.

---

## The response contract (this is the important part)

Every assistant reply is **one JSON object of one of two shapes**:

**1. A clarifying question** (the model still needs information):
```json
{ "question": "What academic qualification is required for this role?" }
```

**2. The final job description** (the model has enough info):
```json
{
  "jobTitle": "Sales Executive for Zomato",
  "jobDescription": "Channelplay is hiring a Sales Executive for its project with Zomato. In this role you will visit restaurants and onboard them.\n\nResponsibilities:\n- Visit restaurants in your area and meet owners.\n- Explain the partnership benefits.\n\nRequirements:\n- College degree in any subject.\n- 0–3 years of field sales experience.\n- Basic English and Hindi."
}
```

Notes:
- `jobDescription` is **one string** containing an intro paragraph, then a
  `Responsibilities:` section, then a `Requirements:` section, separated by
  newlines. Treat it as **opaque multi‑line text** — do **not** assume a specific
  bullet character or split it into structured fields.
- The reply may, in the future, contain **additional keys** (e.g. an optional
  `additionalSections`). Your parser must **not crash on unknown keys** — ignore
  what you don't recognize.

### What is changing (do not depend on the old quirks)

| Aspect | Today (before) | After Sophy schema (target) |
|---|---|---|
| JSON validity | Often **invalid** (raw newlines in strings) | **Always valid** |
| Code fence | Sometimes ```` ```json … ``` ````, sometimes not | **Never fenced** |
| Newlines in `jobDescription` | Raw/unescaped | Properly escaped (`\n`) |
| Top‑level keys | Mostly `question` **or** `jobTitle`+`jobDescription`, occasionally extra | Same two shapes, consistently |

Your parser must rely **only** on the contract above (two shapes, JSON object),
never on the presence of a fence, raw newlines, or line positions.

---

## Required changes

1. **Centralize parsing.** Create a single function, e.g. `parseSophyReply(rawAssistantContent)`,
   that all reply handling goes through. Remove scattered/ad‑hoc parsing.

2. **Strip an optional Markdown code fence** before parsing (for backward
   compatibility — old replies are sometimes fenced; new ones never are).

3. **Parse as JSON**, then **branch on shape**:
   - has a string `question` → a **clarifying‑question turn**: display the
     question and let the user answer (continue the conversation).
   - has `jobTitle` and/or `jobDescription` → the **final JD**: render it.

4. **Render `jobDescription` preserving line breaks** — e.g. CSS
   `white-space: pre-wrap`, or split on `\n`, or render as Markdown. Do **not**
   collapse or re‑parse the section text.

5. **Continue the conversation correctly.** When the user replies to a question,
   append the model's previous reply to the history as the **assistant** message
   and send the full history again. Echo the assistant content consistently
   (the JSON string the model returned is fine).

6. **Fail gracefully.** If a reply can't be parsed as JSON (possible only during
   the transition window, before the schema is enabled), do **not** crash — show
   a "please try again" state and log the raw content. After the schema is live
   this path should never trigger.

7. **Delete fragile logic**, specifically anything that:
   - assumes a code fence is always present (or always absent);
   - splits the reply into "first line / second line";
   - extracts fields with regex over raw newlines;
   - throws or breaks on unexpected/extra keys;
   - requires `jobTitle`/`jobDescription` to be present on *every* reply
     (clarifying turns won't have them).

---

## Reference implementation (TypeScript — adapt to your language/framework)

```ts
type SophyReply =
  | { kind: 'question'; question: string }
  | { kind: 'jd'; jobTitle: string; jobDescription: string; extra: Record<string, unknown> }
  | { kind: 'unparseable'; raw: string };

export function parseSophyReply(rawAssistantContent: string): SophyReply {
  let text = (rawAssistantContent ?? '').trim();

  // 1) Strip an optional ```json … ``` fence (legacy replies only).
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();

  // 2) Parse JSON. With the schema enabled this always succeeds.
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { kind: 'unparseable', raw: rawAssistantContent };
  }
  if (!obj || typeof obj !== 'object') {
    return { kind: 'unparseable', raw: rawAssistantContent };
  }
  const o = obj as Record<string, unknown>;

  // 3) Branch on shape. Question turn first.
  if (typeof o.question === 'string' && o.jobTitle == null && o.jobDescription == null) {
    return { kind: 'question', question: o.question };
  }
  if (typeof o.jobTitle === 'string' || typeof o.jobDescription === 'string') {
    const { jobTitle, jobDescription, question, ...extra } = o;
    return {
      kind: 'jd',
      jobTitle: typeof jobTitle === 'string' ? jobTitle : '',
      jobDescription: typeof jobDescription === 'string' ? jobDescription : '',
      extra, // unknown/extra keys preserved, never fatal
    };
  }
  return { kind: 'unparseable', raw: rawAssistantContent };
}
```

Example UI usage:
```ts
const reply = parseSophyReply(getAssistantText(response));
switch (reply.kind) {
  case 'question': showAssistantQuestion(reply.question); break;
  case 'jd':       renderJobDescription(reply.jobTitle, reply.jobDescription); break; // pre-wrap newlines
  case 'unparseable': showRetryState(); logWarn('Unparseable Sophy reply', reply.raw); break;
}
```

> Optional (transition only): if you want to tolerate the *legacy* malformed
> replies during the brief window before the schema is enabled, you may add a
> best‑effort repair that escapes raw newlines inside JSON string values before
> `JSON.parse`. This is optional and can be removed once the schema is live —
> the recommended approach is simply to enable the Sophy schema right after this
> app change deploys, so the gap is negligible.

---

## Acceptance criteria

The app must correctly handle all of these. Add tests for each:

1. **Clean final JD (new format)** — input
   `{"jobTitle":"Sales Executive for Zomato","jobDescription":"Intro.\n\nResponsibilities:\n- A\n- B\n\nRequirements:\n- C"}`
   → renders the title and the description **with its line breaks preserved**.
2. **Clean question (new format)** — input `{"question":"What is the role title?"}`
   → shows the question and waits for the user; does **not** try to render a JD.
3. **Legacy fenced** — input ```` ```json\n{"question":"…"}\n``` ```` → fence
   stripped, parsed correctly.
4. **Unknown extra key** — input
   `{"jobTitle":"X for Y","jobDescription":"…","SomethingNew":"…"}` → renders the
   JD, does **not** crash on the extra key.
5. **Unparseable** — input `not json` → shows a graceful retry/error state, no
   crash.
6. **Multi‑turn** — a question turn followed by a user answer correctly appends
   the assistant reply to history and produces the next reply.

---

## Rollout sequence (important)

1. Implement and deploy this app change.
2. Verify against the acceptance criteria above (especially #1 and #2 with the
   new clean format).
3. **Only then** enable the strict output schema on the Sophy key.

This ordering guarantees the app is already robust to the clean responses before
Sophy starts sending them. Keeping the tolerant parser permanently is fine — it
costs nothing and protects against future format drift.

## Out of scope (do not do)

- Do not change the model, the system prompt, or any Sophy/admin configuration.
- Do not hard‑code the presence of a code fence or any raw‑newline assumption.
- Do not require `jobTitle`/`jobDescription` on every turn (clarifying turns
  legitimately omit them).
- Do not put secrets (the `mw_live_…` key) in code or logs that weren't already
  there; reuse the app's existing config mechanism.
