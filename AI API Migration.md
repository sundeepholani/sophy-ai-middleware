# Migrating to Sophy

Sophy is a project-scoped AI gateway. Applications authenticate with a
Sophy-issued `mw_live_...` key instead of a provider key. Each project connects
its own Vercel AI Gateway credential, and each Sophy key is bound
to one model and carries the operator-owned prompt, generation parameters,
optional JSON schema, knowledgebase, rate limit, and monthly USD budget.

Sophy provides an OpenAI-compatible subset for Chat Completions, Responses,
embeddings, image generation, model discovery, and temporary file uploads.

## TL;DR

| Current client | Migration |
|---|---|
| OpenAI SDK: Chat Completions | Change `base_url` and `api_key`; keep using `chat.completions.create`. |
| OpenAI SDK: Responses | Change `base_url` and `api_key`; keep using `responses.create`, but send full history because Sophy is stateless. |
| OpenAI SDK: embeddings or images | Change `base_url` and `api_key`; use a Sophy key bound to the matching model type. |
| Anthropic/Claude SDK | Switch to the OpenAI SDK pointed at Sophy. The key can still select a Claude model. |

- **Base URL:** `https://sophy.in/v1`
- **API key:** a Sophy key issued inside your project in the console
- **Model:** the key's configured model always wins; send a placeholder such as
  `"sophy"` when the SDK requires a `model` argument
- **Prompt and parameters:** key-owned by default; client values are ignored
- **Tools:** passed to the model and returned to your application; Sophy never
  executes them

## 1. Get a correctly configured key

Ask the operator for a key suited to your endpoint:

- a language model for `/chat/completions` or `/responses`,
- an embedding model for `/embeddings`, or
- an image model for `/images/generations`.

The operator can also configure a system prompt, temperature, top-p, maximum
output tokens, structured-output schema, knowledgebase, RPM limit, monthly USD
budget, content logging, and optional agent mode. Store the key in a secret such
as `SOPHY_API_KEY`.

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

## 8. Structured output

Structured output is configured on the key, not per request. Client
`response_format` or Responses `text.format` does not replace the stored schema.
Do not combine a structured-output key with function tools.

For a buffered call, Sophy validates the returned object and responds with an
OpenAI-shaped `502` (`schema_validation_failed`) instead of returning invalid
JSON. For a streaming call, validation is recorded after completion; bytes that
were already sent cannot be recalled, so validate streamed JSON in your client
before using it.

## 9. Moving from the Anthropic SDK

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

## 10. Errors and limits

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
| `400` | Invalid JSON/input, unsupported field or feature, a known non-embedding/image model on those modality endpoints, malformed media URL, or upstream input rejection. |
| `401` | Missing, invalid, expired, or revoked Sophy key, or a key whose project is inactive. |
| `402` | The Sophy key's monthly USD budget is exhausted. |
| `403` | A Sophy-hosted file belongs to another key. |
| `413` | `/v1/files` upload exceeds 4 MiB (4,194,304 bytes). |
| `429` | Sophy RPM limit or upstream provider rate/quota limit; honor `Retry-After` when present. |
| `502` | A transient upstream service failure or buffered structured-output failure. |
| `503` | The Sophy key is valid, but its project has no usable Vercel AI Gateway credential (`project_gateway_unavailable`). |

Usage and cost in the console are real-time gateway estimates, not a provider
invoice. A monthly budget is checked before a request; the request that reaches
the remaining budget can still add its final cost. If an upstream failure occurs
after SSE streaming begins, the stream ends instead of changing into a JSON
error response; clients should treat an incomplete stream as failed.

## 11. Smoke test

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

**Do Chat, Responses, embeddings, and images use different base URLs?** No. They
share `https://sophy.in/v1`; choose the SDK method and a key whose configured
model matches that endpoint.
