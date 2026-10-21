# Migrating to Sophy

Sophy is a project-scoped AI gateway. Applications authenticate with a
Sophy-issued `mw_live_...` key instead of a provider key. Each project connects
its own Vercel AI Gateway credential, plus its own Cloudflare Workers AI
credential when it uses Cloudflare's Clef or Clairic models, and each Sophy key
is bound to one primary model and carries the operator-owned prompt, generation
parameters, optional JSON schema, knowledgebase, rate limit, and monthly USD
budget. A transcription key can also name a language model that applies the
operator-owned prompt after speech-to-text.

Sophy provides an OpenAI-compatible subset for Chat Completions, Responses,
audio transcription, embeddings, image generation, model discovery, and
temporary file uploads. Evaluation and extraction models are served by native
`POST /v1/evaluate` and `POST /v1/extract` routes instead, because no OpenAI
client method reaches them.

## TL;DR

| Current client | Migration |
|---|---|
| OpenAI SDK: Chat Completions | Change `base_url` and `api_key`; keep using `chat.completions.create`. |
| OpenAI SDK: Responses | Change `base_url` and `api_key`; keep using `responses.create`, but send full history because Sophy is stateless. |
| OpenAI SDK: audio transcription | Change `base_url` and `api_key`; keep using `audio.transcriptions.create` with a Sophy key bound to a transcription model. |
| OpenAI SDK: embeddings or images | Change `base_url` and `api_key`; use a Sophy key bound to the matching model type. |
| Vercel AI Gateway: evaluation | Change the base URL to `https://sophy.in/v1` and the bearer token to your Sophy key; `POST /v1/evaluate` keeps the same body. There is no OpenAI SDK method for it. |
| Cloudflare Workers AI: Clef (`@cf/cloudflare/clef`, `clef-flash`, `clef-omni`) | Send Sophy's evaluate body to `https://sophy.in/v1/evaluate` with your Sophy key: `boolean` instead of `noul`, images in `assets` instead of `images`; `model` is ignored. See §9. |
| Cloudflare Workers AI: Clairic (`@cf/cloudflare/clairic`) | Send the same `state`, `fields`, `reference_date`, and `options` to `https://sophy.in/v1/extract`, with images in `assets` instead of `images`. The response is not wrapped in Cloudflare's `result` envelope. See §10. |
| Anthropic/Claude SDK | Switch to the OpenAI SDK pointed at Sophy. The key can still select a Claude model. |

- **Base URL:** `https://sophy.in/v1`
- **API key:** a Sophy key issued inside your project in the console
- **Model:** the key's configured primary model always wins; send a placeholder
  such as `"sophy"` when the SDK requires a `model` argument
- **Prompt and parameters:** key-owned by default; client values are ignored
- **Tools:** passed to the model and returned to your application; Sophy never
  executes them

## 1. Get a correctly configured key

Ask the operator for a key suited to your endpoint:

- a language model for `/chat/completions` or `/responses`,
- a transcription model for `/audio/transcriptions`,
- an embedding model for `/embeddings`,
- an image model for `/images/generations`,
- an evaluation model for `/evaluate`, or
- an extraction model for `/extract`.

The operator can also configure a system prompt, temperature, top-p, maximum
output tokens, structured-output schema, knowledgebase, RPM limit, monthly USD
budget, content logging, optional agent mode, and an optional transcript
processor model. Store the key in a secret such as `SOPHY_API_KEY`.

## 2. Point the OpenAI SDK at Sophy

### Chat Completions

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["SOPHY_API_KEY"],
    base_url="https://sophy.in/v1",
)

response = client.chat.completions.create(
    model="sophy",  # ignored; the Sophy key selects the model
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SOPHY_API_KEY,
  baseURL: "https://sophy.in/v1",
});

const response = await client.chat.completions.create({
  model: "sophy",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.choices[0].message.content);
```

Set `stream=True` in Python or `stream: true` in JavaScript to stream. Chat SSE
uses the normal OpenAI chunk shape and `[DONE]` sentinel. If you need usage in a
chat stream, send `stream_options={"include_usage": True}`.

### Responses API

```python
response = client.responses.create(
    model="sophy",
    input="Hello",
)
print(response.output_text)
```

```ts
const response = await client.responses.create({
  model: "sophy",
  input: "Hello",
});
console.log(response.output_text);
```

Buffered and streaming Responses calls are supported. Sophy does not store
Responses state: `previous_response_id` returns `400`, and `store` does not create
retrievable state. Send the full conversation and any prior
function-call/function-result items on each request.

## 3. Prompt ownership and agent mode

By default, Sophy ignores:

- the request's `model`,
- Chat `system` and `developer` messages,
- Responses `instructions` and system/developer input items, and
- request-level `temperature`, `top_p`, `max_tokens`,
  `max_completion_tokens`, and `max_output_tokens`.

The key's configured values are used instead. Remove duplicated client settings
where practical.

For trusted server-side agents whose instructions legitimately change per
request, ask the operator to enable **Agent mode** on the key. In that mode,
Sophy appends Responses `instructions` and leading Chat/Responses
system/developer text after the key-owned prompt. Collection stops at the first
non-system item. Agent mode gives client text operator-level influence, so do
not use it on clients that pass end-user-authored system messages.

## 4. Function tools

Function tools work on both Chat Completions and Responses, buffered or
streaming. Sophy forwards definitions and `tool_choice`, returns the model's tool
calls, and preserves tool-result turns. Your application owns the tool loop:

1. send tool definitions,
2. receive tool calls,
3. validate and execute them in your application,
4. append the assistant call plus tool result, and
5. call Sophy again.

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

response = client.chat.completions.create(
    model="sophy",
    messages=[{"role": "user", "content": "Weather in Delhi?"}],
    tools=tools,
    tool_choice="auto",
)

for call in response.choices[0].message.tool_calls or []:
    # Your code validates arguments and executes get_weather(...).
    print(call.id, call.function.name, call.function.arguments)
```

Sophy supports function tools, not provider-hosted tools such as built-in web
search. The legacy top-level Chat `functions` parameter returns `400`; use
`tools`. A key configured for structured output also returns `400` when function
tools are supplied in the same request.

## 5. Multimodal input and temporary files

For a vision-capable language model, use standard OpenAI content parts. Public
URLs and inline `data:` URLs work.

```python
response = client.chat.completions.create(
    model="sophy",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What is in this image?"},
            {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
        ],
    }],
)
```

Responses uses `input_text`, `input_image`, and `input_file` part types instead.
The selected model must advertise the relevant image/file-input capability.

To obtain a reusable Sophy URL, upload with multipart form data:

```bash
curl https://sophy.in/v1/files \
  -H "Authorization: Bearer $SOPHY_API_KEY" \
  -F "file=@report.pdf"
```

Read the `url` from the `201` response and use it as `image_url`, `file_url`, or
`file_data` with the same key. Sophy rejects a reference to another key's upload.

Upload limits:

- maximum 4 MiB (4,194,304 bytes) per file,
- PDF, PNG, JPEG, WebP, GIF, plain text, CSV, and JSON only, and
- eligibility for batched cleanup after 24 hours; do not treat uploads as durable.

Knowledgebase documents are managed separately by operators and are not subject
to this 24-hour client-upload sweep.

Sophy upload URLs are public but unguessable so model providers can fetch them.
Treat them as bearer URLs. Sophy enforces issuing-key ownership when one of its
URLs is submitted back through the API.

## 6. Embeddings

Use a key bound to an embedding model:

```python
response = client.embeddings.create(
    model="sophy",
    input=["first document", "second document"],
    encoding_format="float",
)
vectors = [item.embedding for item in response.data]
```

`input` accepts one string or up to 2,048 strings. `encoding_format` may be
`"float"` or `"base64"`; official OpenAI clients can decode the base64 form.
Pre-tokenized integer arrays are not supported because tokenization is
model-specific. The optional `dimensions` field works only with `openai/*`
embedding models.

If you are migrating an existing vector store, configure the Sophy key with the
same embedding model and dimensions before generating new vectors.

## 7. Image generation

Use a key bound to an image-generation model:

```python
response = client.images.generate(
    model="sophy",
    prompt="A paper-cut illustration of a monsoon city",
    n=1,
    size="1024x1024",
    response_format="b64_json",
)
image_base64 = response.data[0].b64_json
```

Sophy accepts 1-10 images and validates sizes in `WIDTHxHEIGHT` form. It returns
base64 data only; `response_format="url"` is not supported. `quality`, `style`,
`background`, and `output_format` are forwarded when supplied, but their actual
support depends on the configured provider/model. Sophy does not store generated
images.

## 8. Audio transcription

Use a key bound to a transcription model and send the audio as multipart form
data:

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["SOPHY_API_KEY"],
    base_url="https://sophy.in/v1",
)

with open("meeting.m4a", "rb") as audio:
    response = client.audio.transcriptions.create(
        model="sophy",  # ignored; the Sophy key selects the transcription model
        file=audio,
        language="en",
        response_format="json",
    )

print(response.text)
```

The required `file` may be MP3/MPEG/MPGA, MP4/M4A, WAV, WebM, FLAC, or OGG
and must not exceed 4 MiB (4,194,304 bytes). Sophy detects the format from the
audio bytes rather than trusting the filename or MIME type. `language` is an
optional two-letter ISO-639-1 hint such as `"en"`. `response_format` is optional
but only `"json"` is supported in this version. Client `prompt`, `temperature`,
`logprobs`, `stream`, timestamp, diarization, chunking, and known-speaker
options are rejected rather than silently ignored.

When a processing policy is configured, the response contains only the
policy-processed text:

```json
{
  "text": "Decisions: launch on Friday and send the checklist today.",
  "processed": true,
  "language": "en",
  "duration": 8.4
}
```

With a blank key system prompt, `text` and `transcript` are identical and
`processed` is `false`. With a non-blank system prompt, the operator must also
configure `params.transcriptProcessorModel` with a language model. Sophy first
creates the raw transcript, then uses that prompt and processor model to produce
`text`; the raw `transcript` field is omitted so clients cannot bypass a
centrally managed transformation such as redaction. This second step can
summarize, format, translate, or otherwise transform the transcript. It is not
controlled by a client `prompt`.

One clip consumes one RPM slot and counts as one client request. Sophy attributes
the transcription and optional processor to their actual models, while the
processor component does not add a second client request. When content logging
is enabled, the filename, size, language hint, raw transcript, and final text can
be retained for 30 days; the audio bytes are never stored. Disable content
logging on the key when an unprocessed transcript must not be retained.

The equivalent curl request is:

```bash
curl https://sophy.in/v1/audio/transcriptions \
  -H "Authorization: Bearer $SOPHY_API_KEY" \
  -F "file=@meeting.m4a" \
  -F "model=sophy" \
  -F "language=en" \
  -F "response_format=json"
```

## 9. Evaluation models

Evaluation models are **not** reachable through the OpenAI SDK. Vercel documents
them as unavailable on the OpenAI-, Anthropic- and Cohere-compatible endpoints,
so Sophy mirrors the AI Gateway's own `POST /v1/evaluate` shape. Use a plain HTTP
client and a key bound to an evaluation model. Cloudflare's Clef models use the
same Sophy request shape; see *Cloudflare Clef models* below.

```bash
curl https://sophy.in/v1/evaluate \
  -H "Authorization: Bearer $SOPHY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "Q: How do I reset my password? A: Open Settings and use the reset link.",
    "questions": {
      "grounded": {
        "type": "boolean",
        "instructions": "Is the answer supported by the question?"
      },
      "tone": {
        "type": "choice",
        "instructions": "Classify the tone of the answer.",
        "criteria": {
          "formal": "Professional and impersonal.",
          "casual": "Friendly and conversational."
        }
      },
      "helpfulness": {
        "type": "score",
        "instructions": "Rate how helpful the answer is.",
        "criteria": ["useless", "partial", "complete"]
      }
    }
  }'
```

The same request from Python, using `httpx` rather than the OpenAI SDK:

```python
import os
import httpx

response = httpx.post(
    "https://sophy.in/v1/evaluate",
    headers={"Authorization": f"Bearer {os.environ['SOPHY_API_KEY']}"},
    json={
        "state": {
            "question": "How do I reset my password?",
            "answer": "Open Settings and use the reset link we email you.",
        },
        "questions": {
            "grounded": {
                "type": "boolean",
                "instructions": "Is the answer supported by the question?",
            },
            "helpfulness": {
                "type": "score",
                "instructions": "Rate how helpful the answer is.",
                "criteria": ["useless", "partial", "complete"],
            },
        },
    },
    timeout=120,
)
print(response.json()["answers"])
```

Request fields:

- `state` is required and may be a string, object, or array. It is the shared
  material every question is asked about, and must not exceed 200,000 characters
  once serialized as JSON.
- `questions` is required and maps your own question names to question objects.
  Send 1-32 of them. Every question needs a non-empty `instructions` string and a
  `type` of `"boolean"`, `"choice"`, or `"score"`.
  - `boolean` takes an optional `criteria` object with string `true` and `false`
    descriptions, and answers with a `probability`.
  - `choice` requires a `criteria` object mapping at least two option names to
    descriptions, and answers with the chosen option plus a probability per
    option.
  - `score` requires a `criteria` array of at least two string labels ordered
    lowest to highest, and answers with a numeric `score` plus probabilities.
  - On Cloudflare Clef keys, question names must be 1-100 letters, digits, `_`,
    `.`, or `-`; `choice` takes at most 255 options and `score` at most 10
    levels.
- `providerOptions` is optional and may only address the namespace belonging to
  the key model's provider. Clef keys reject it.
- `assets` is optional and carries still images, keyed by a name of 1-64
  letters, digits, `_`, or `-`. Each entry is
  `{ "type": "image", "format": "png", "data_base64": "..." }` with standard
  padded base64 and no `data:` prefix; `format` is `png`, `jpg`, or `jpeg`, or
  also `webp` on Clef keys. TypeSafe Jev 1.13.0+ keys accept 1-8 images, and
  each key must appear in `state`, an instruction, or criteria. Cloudflare Clef
  keys accept 1-4 images, at most 4 MiB each and 8 MiB in total once decoded,
  with no reference needed. The whole request must stay under 4.5 MB.
- `model` is accepted and ignored, exactly as on every other surface; the
  evaluation model configured on the key wins and is echoed back.

The response contains the key's model, one answer per question, and token usage.
Choice and score answers include `confidence` (0-1) when the model returns one.
Score `probabilities` are keyed by level index (`"0"` is the lowest label), and
`score` is probability-weighted, so it can fall between levels:

```json
{
  "model": "typesafe-ai/jev",
  "answers": {
    "grounded": { "type": "boolean", "probability": 0.93 },
    "tone": {
      "type": "choice",
      "choice": "casual",
      "probabilities": { "formal": 0.18, "casual": 0.82 }
    },
    "helpfulness": {
      "type": "score",
      "score": 1.71,
      "probabilities": { "0": 0.04, "1": 0.21, "2": 0.75 }
    }
  },
  "usage": { "inputTokens": 412, "outputTokens": 36, "totalTokens": 448 }
}
```

The call is buffered; there is no streaming, and upstream `providerMetadata` is
not echoed. One evaluate call consumes one RPM slot and is checked against the
key's monthly budget before the paid model call. When content logging is enabled
on the key, Sophy stores the evaluated state, the questions, and the answers;
images are logged as format and size only.

Validation failures arrive as `400` with a specific `code`: `missing_state`,
`state_too_large`, `missing_questions`, `invalid_questions`, `questions_empty`,
`too_many_questions`, `invalid_question`, `missing_instructions`,
`unsupported_question_type`, `invalid_criteria`, `invalid_question_id`,
`unsupported_provider_options`, or `unsupported_media_field`. Image problems
return `assets_not_supported`, `invalid_assets`, `too_many_assets`,
`invalid_asset_key`, `invalid_asset`, `unsupported_asset_format`,
`invalid_asset_data`, `asset_format_mismatch`, `asset_too_large`,
`assets_too_large`, or `unreferenced_asset`. A key whose model is known to be
something other than an evaluation model returns `400 model_not_evaluation`.

### Cloudflare Clef models

Keys bound to `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, or
`@cf/cloudflare/clef-omni` use the same request and response as any evaluation
key. Sophy calls Cloudflare Workers AI with your project's own Cloudflare
credential; the project's Admin connects it once in Sophy, and your application
only ever sends its Sophy key. If you call Clef through Cloudflare's API today:

- Use `"type": "boolean"` where Cloudflare uses `noul`; Sophy translates both
  ways and answers with `probability`. A `noul` question returns
  `400 unsupported_question_type`.
- Leave out `model`. The key chooses the Clef model and Sophy sends Cloudflare's
  selector itself.
- Send images in `assets` (see the field list above), not `images`. Clef sees
  every image before the state, in the key order of `assets`, and Sophy does not
  replace a key with its image, so refer to images by position ("the first
  image"). As in JavaScript, keys that are plain whole numbers, such as `"2"`,
  come first in numeric order. Top-level `images`, `audio`, or `videos` return
  `400 unsupported_media_field`; Cloudflare's video input, and Clef Omni's audio
  input, are not supported yet. Each image is limited to 4 MiB (8 MiB in total)
  and, by Cloudflare, to 16 megapixels, which Sophy does not check.
- Instructions, choice descriptions, and score labels must be non-empty
  strings. Cloudflare's `null`, object, and array forms return
  `400 missing_instructions` or `400 invalid_criteria`.
- `providerOptions` is rejected (`400 unsupported_provider_options`).
- Responses are not wrapped in Cloudflare's `{ result, success, errors }`
  envelope. Choice and score answers carry `confidence`; score answers drop
  Cloudflare's `legend`, so read levels from the `probabilities` keys. Usage is
  camelCase (`inputTokens`, `outputTokens`, `totalTokens`).
- Sophy estimates the request size as Cloudflare does (the JSON it sends
  upstream, without images, divided by 4) and returns `400 state_too_large` when
  the estimate is above the model's context window: 65,536 tokens for Clef and
  Clef Omni and 24,576 for Clef Flash (about 98,000 characters of JSON). Dense
  text can still exceed the real token limit below that estimate. In testing,
  Clef and Clef Flash rejected such requests instead of shortening the state,
  and Sophy returns `400 upstream_invalid_request` with Cloudflare's message,
  such as `Request requires 100819 tokens; the maximum is 65529`. Clef Omni's
  limit is also its context window, and over-long input is expected to be
  rejected the same way, but that has not been verified. Keep the state well
  inside the context window.

A project whose Cloudflare credential is missing or unhealthy returns
`503 project_gateway_unavailable`, even when its Vercel AI Gateway credential is
healthy. A Cloudflare account on the Workers Free plan that has used its daily
free allocation returns `429 rate_limit_exceeded` until 00:00 UTC, and Sophy
does not retry it.

## 10. Extraction models (preview)

Extraction models read text and images and return typed values instead of free
text. Sophy serves Cloudflare's Clairic (`@cf/cloudflare/clairic`) on a native
`POST /v1/extract` route; like evaluation, no OpenAI SDK method reaches it. Use
a plain HTTP client and a key bound to Clairic. Clairic is a Cloudflare research
preview: Sophy validates your request, then passes each answer through exactly
as Clairic returns it, so answer fields can change between releases. Calls use
the project's own Cloudflare Workers AI credential, never Vercel AI Gateway.

```bash
curl https://sophy.in/v1/extract \
  -H "Authorization: Bearer $SOPHY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "Invoice INV-7731 from Blue Harbor Logistics. Issued 14 Oct. Net 15. Freight: 3 pallets at $410.00 each; fuel surcharge $57.50. Contacts: Meera Iyer, Tom Okafor.",
    "reference_date": "2026-10-20",
    "fields": {
      "invoice_number": { "type": "text", "instructions": "Invoice number" },
      "total": { "type": "number", "unit": "USD", "decimals": 2, "instructions": "Amount due including the surcharge" },
      "due_date": { "type": "date", "instructions": "Issue date plus the net payment days" },
      "contacts": { "type": "list", "items": "text", "instructions": "Contact person names" },
      "po_number": { "type": "text", "instructions": "Purchase order number" },
      "days_to_pay": { "type": "estimate", "min": 0, "max": 90, "step": 1, "instructions": "Days after issue until this invoice is paid" }
    }
  }'
```

The same request from Python:

```python
import os
import httpx

response = httpx.post(
    "https://sophy.in/v1/extract",
    headers={"Authorization": f"Bearer {os.environ['SOPHY_API_KEY']}"},
    json={
        "state": (
            "Invoice INV-7731 from Blue Harbor Logistics. Issued 14 Oct. Net 15. "
            "Freight: 3 pallets at $410.00 each; fuel surcharge $57.50. "
            "Contacts: Meera Iyer, Tom Okafor."
        ),
        "reference_date": "2026-10-20",
        "fields": {
            "invoice_number": {"type": "text", "instructions": "Invoice number"},
            "total": {
                "type": "number",
                "unit": "USD",
                "decimals": 2,
                "instructions": "Amount due including the surcharge",
            },
            "due_date": {"type": "date", "instructions": "Issue date plus the net payment days"},
            "contacts": {"type": "list", "items": "text", "instructions": "Contact person names"},
            "po_number": {"type": "text", "instructions": "Purchase order number"},
            "days_to_pay": {
                "type": "estimate",
                "min": 0,
                "max": 90,
                "step": 1,
                "instructions": "Days after issue until this invoice is paid",
            },
        },
    },
    timeout=120,
)
print(response.json()["answers"])
```

Request fields:

- `state` is a string of at most 200,000 characters. It is required unless
  `assets` carries images, in which case it may be `""` or omitted. Objects and
  arrays are rejected (`invalid_state`); serialize them yourself. The limit
  counts UTF-16 code units (JavaScript string length), so an emoji counts as
  two. Sophy also estimates the request as Cloudflare does (the JSON it sends
  upstream, without images, divided by 4) and returns `400 state_too_large`
  above Clairic's 65,536-token context window, about 262,000 characters of
  JSON. JSON writes each newline, tab, quote, and backslash as two characters
  (other control characters as six), so a newline-dense series, tab- or
  quote-heavy CSV/TSV, or serialized JSON can hit that limit below 200,000
  characters.
- `fields` is required and maps 1-64 of your own field names to field specs.
  A name starts with a letter or `_` and has at most 64 letters, digits, `_`,
  `.`, or `-`. Each spec needs a `type`: `text`, `number`, `date`, `time`,
  `datetime`, `duration`, `list`, `estimate`, or `forecast`. Optional settings:
  `instructions` (string), `unit` (a non-empty string; duration fields accept
  only `seconds`, the default, `minutes`, `hours`, `days`, `weeks`, `months`, or
  `years`), `integer` (boolean), `decimals` (0-6), `items` (`text`, `number`, or
  `date`; required for lists), `min` and `max` (required for estimates and
  forecasts, `min` below `max`; ISO dates only for a date estimate; optional
  numbers on other types), `step` (a positive number; `"month"` or `"year"` only
  on a date estimate), `scale` (`linear` or `log`, for estimates and forecasts),
  `null_threshold` (greater than 0, at most 1), `horizon` (forecast steps, 1-64),
  and `interval` (`step`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, or
  `year`). Any other setting is rejected.
- `assets` is optional: 1-4 PNG, JPEG, or WebP images with the same shape and
  limits as Clef keys in §9. Clairic sees them before the state, in key order.
- `reference_date` is an optional `YYYY-MM-DD` date that anchors dates written
  without a year. Sophy never fills it in; send it whenever a field depends on
  today's date.
- `options` may hold `include_quantiles` (adds all 99 percentiles to estimates)
  and `return_state_text` (adds `state_text`, the text spans index into), both
  booleans.
- `model` is accepted and ignored; the key's model wins and is echoed back.

The response holds the key's model, one answer per field, Clairic's
`truncated` flag, `state_text` when requested, and token usage. Numbers below
are rounded for reading:

```json
{
  "model": "@cf/cloudflare/clairic",
  "answers": {
    "invoice_number": { "type": "text", "p_null": 0.0001, "span": [8, 16], "guess": "INV-7731", "confidence": 1, "value": "INV-7731" },
    "total": { "type": "number", "p_null": 0.0003, "guess": 1287.5, "confidence": 0.8683, "value": 1287.5 },
    "due_date": { "type": "date", "p_null": 0.00001, "guess": "2026-10-29", "confidence": 0.9999, "value": "2026-10-29" },
    "contacts": { "type": "list", "value": ["Meera Iyer", "Tom Okafor"], "spans": [[137, 147], [149, 159]], "confidence": 0.9708 },
    "po_number": { "type": "text", "p_null": 0.999999, "span": [8, 16], "guess": "INV-7731", "confidence": 0.9993, "value": null },
    "days_to_pay": { "type": "estimate", "value": 18, "mean": 17.58, "median": 16, "p10": 13, "p90": 25, "p_below": 0.000009, "p_above": 0.000009 }
  },
  "truncated": false,
  "usage": { "inputTokens": 715, "outputTokens": 0, "totalTokens": 715 }
}
```

Read answers with three rules:

1. **Spans are Unicode code-point offsets**, end-exclusive. `state[start:end]`
   works in Python. In JavaScript use
   `Array.from(state).slice(start, end).join("")`; `state.slice()` counts UTF-16
   units and drifts after an emoji.
2. **When `value` is `null`, ignore `guess` and `span`**, even when
   `confidence` is high. `po_number` above has no PO number in the input, yet
   its guess points at the invoice number. `p_null` is the probability that the
   input does not determine the field.
3. **Lists can carry per-item `confidences`** alongside the overall
   `confidence` (seen on number and date lists); text lists carry per-item
   `spans`. Check each item before you use it.

Estimates add `mean`, `median`, `p10`, `p90`, `p_below`, and `p_above`
(`p10`-`p90` is an 80% interval), and `value` can differ from `median`. Forecast
`value`, `median`, `p10`, and `p90` are arrays with one entry per step, and
`steps` holds one estimate per step. Clairic may read the state more than once
(the example above used 3 passes), and `inputTokens` counts every pass, so cost
is not predictable from the field count alone.

The call is buffered. One extract call consumes one RPM slot and is checked
against the key's monthly budget before the paid model call. When content
logging is enabled on the key, Sophy stores the state, field specs, reference
date, options, and answers; images are logged as format and size only, and
`state_text` is never logged.

Validation failures arrive as `400` with a specific `code`: `invalid_state`,
`missing_state`, `state_too_large`, `missing_fields`, `invalid_fields`,
`fields_empty`, `too_many_fields`, `invalid_field_name`,
`unsupported_field_type`, `invalid_field`, `invalid_reference_date`,
`invalid_options`, `unsupported_media_field`, or one of the image codes in §9.
A key whose model is not an extraction model, a Clef key included, returns
`400 model_not_extraction`. A project without a healthy Cloudflare credential
returns `503 project_gateway_unavailable`. Clairic's own rejections return
`400 upstream_invalid_request` with its message.

## 11. Structured output

Structured output is configured on the key, not per request. Client
`response_format` or Responses `text.format` does not replace the stored schema.
Do not combine a structured-output key with function tools.

For a buffered call, Sophy validates the returned object and responds with an
OpenAI-shaped `502` (`schema_validation_failed`) instead of returning invalid
JSON. For a streaming call, validation is recorded after completion; bytes that
were already sent cannot be recalled, so validate streamed JSON in your client
before using it.

## 12. Moving from the Anthropic SDK

The Anthropic SDK cannot call Sophy's OpenAI-compatible endpoints directly.
Switch to the OpenAI SDK and point it at Sophy; the operator can bind the key to
a Claude model.

| Anthropic | OpenAI SDK through Sophy |
|---|---|
| `client.messages.create(...)` | `client.chat.completions.create(...)` |
| `system="..."` | Remove by default; ask for Agent mode only for trusted dynamic instructions. |
| `max_tokens=...` | Remove; configured on the key. |
| `model="claude-..."` | Use an SDK placeholder; the key selects the Claude model. |
| `messages=[...]` | Same user/assistant conversation, using OpenAI content-part names. |
| `msg.content[0].text` | `response.choices[0].message.content` |
| Anthropic tool use | Convert definitions/results to OpenAI function-tool shapes; tools are supported but execute in your application. |

## 13. Errors and limits

Validation and buffered failures use the OpenAI body shape:

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "param": null,
    "code": "..."
  }
}
```

| Status | Typical meaning |
|---|---|
| `400` | Invalid input, unsupported field or feature, a model that does not match the endpoint, invalid audio/multipart data, missing transcription processor configuration, malformed media URL, an invalid `/v1/evaluate` state or question set, an invalid `/v1/extract` state or field set, or upstream input rejection. |
| `401` | Missing, invalid, expired, or revoked Sophy key, or a key whose project is inactive. |
| `402` | The Sophy key's monthly USD budget is exhausted. |
| `403` | A Sophy-hosted file belongs to another key. |
| `413` | A `/v1/files` or `/v1/audio/transcriptions` upload exceeds 4 MiB (4,194,304 bytes). |
| `429` | Sophy RPM limit or upstream provider rate/quota limit; honor `Retry-After` when present. |
| `502` | A transient upstream service failure or buffered structured-output failure. |
| `503` | The Sophy key is valid, but its project has no usable credential for the key model's provider: Vercel AI Gateway, or Cloudflare Workers AI for `@cf/` models (`project_gateway_unavailable`). |

Usage and cost in the console are estimates, not a provider invoice. Cloudflare
Workers AI calls are estimated from the neurons Cloudflare reports ($0.011 per
1,000) or the model's input-token price, ignoring Cloudflare's daily free
allocation. A response Cloudflare billed but Sophy could not use is still
metered from the neurons Cloudflare reports for it, while requests Cloudflare
rejected record no cost. A monthly budget is checked before a request; the
request that reaches the remaining budget can still add its final cost. If an
upstream failure occurs after SSE streaming begins, the stream ends instead of
changing into a JSON error response; clients should treat an incomplete stream
as failed.

For evaluation-specific failures, check the error `code`: `model_not_evaluation`
means the key's primary model is not an evaluation model, while `missing_state`,
`state_too_large`, `missing_questions`, `invalid_questions`, `questions_empty`,
`too_many_questions`, `invalid_question`, `missing_instructions`,
`unsupported_question_type`, `invalid_criteria`, `invalid_question_id`,
`unsupported_provider_options`, and `unsupported_media_field` describe a
malformed request body. Image problems use the asset codes listed in §9.

For extraction-specific failures, `model_not_extraction` means the key's
primary model is not an extraction model, while `invalid_state`,
`missing_state`, `state_too_large`, `missing_fields`, `invalid_fields`,
`fields_empty`, `too_many_fields`, `invalid_field_name`,
`unsupported_field_type`, `invalid_field`, `invalid_reference_date`, and
`invalid_options` describe a malformed request body.

For transcription-specific setup failures, check the error `code`:
`model_not_transcription` means the key's primary model cannot transcribe;
`transcript_processor_required` means the key has processing instructions but no
processor; and `processor_model_not_language` means that processor is not a
language model. Invalid multipart/audio requests use codes such as
`missing_file`, `empty_file`, `unsupported_audio_format`, or
`unsupported_transcription_option`.

## 14. Smoke test

```bash
curl https://sophy.in/v1/chat/completions \
  -H "Authorization: Bearer $SOPHY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"sophy","messages":[{"role":"user","content":"Say hi"}]}'
```

A `200` with `choices[0].message.content` confirms a language key is working.
Call `GET https://sophy.in/v1/models` with the same bearer token to see the model
configured for that key.

## FAQ

**Can my request select another model?** No. Ask the operator to update the key
or issue another key. Changes apply on the next request.

**Can my application send dynamic instructions?** Only when an operator enables
Agent mode for that trusted server-side application. Otherwise client system and
instruction fields are ignored.

**Does Sophy run my functions?** No. It returns function calls in the OpenAI
shape; your application validates, authorizes, executes, and returns results.

**Can I use `previous_response_id`?** No. Sophy's Responses endpoint is stateless;
send the complete input and tool history every time.

**Do I need a Cloudflare account to use Clef or Clairic?** Your application
does not: it sends only its Sophy key. A project Admin connects the project's
Cloudflare account ID and Workers AI API token in Sophy, and that Cloudflare
account is billed for the calls.

**Do Chat, Responses, audio transcription, embeddings, images, evaluation, and
extraction use different base URLs?** No. They share `https://sophy.in/v1`;
choose the SDK method — or, for `/evaluate` and `/extract`, a plain HTTP
request — and a key whose configured primary model matches that endpoint.
