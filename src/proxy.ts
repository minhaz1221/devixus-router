import http from "node:http";
import chalk from "chalk";
import { addUsage, estimateCostUsd } from "./db.js";
import { routePayload } from "./router.js";

export type ProxyOptions = {
  port: number;
};

type AnthropicMessagesRequest = {
  messages?: unknown;
  model?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
  // allow extra fields
  [k: string]: unknown;
};

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 2_000_000
): Promise<{ raw: string; json: unknown }> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return { raw, json: null };

  try {
    return { raw, json: JSON.parse(raw) as unknown };
  } catch {
    return { raw, json: null };
  }
}

function isAnthropicApiRequest(req: http.IncomingMessage): boolean {
  const method = req.method?.toUpperCase();
  if (method !== "POST") return false;

  const url = req.url ?? "";
  return url.startsWith("/v1/messages");
}

function estimateTokensFromMessages(payload: AnthropicMessagesRequest): number {
  const messagesUnknown = payload.messages;
  if (!Array.isArray(messagesUnknown) || messagesUnknown.length === 0) return 0;

  let words = 0;
  for (const m of messagesUnknown as unknown[]) {
    const msg = m as Record<string, unknown> | null;
    const content = msg?.content;
    const text = typeof content === "string" ? content : "";
    if (!text) continue;
    const wordMatches = text.trim().match(/\S+/g);
    if (wordMatches) words += wordMatches.length;
  }

  // assumption from user: 1 word = 1.3 tokens
  return Math.ceil(words * 1.3);
}

function maybeAutoCompact(payload: AnthropicMessagesRequest): {
  triggered: boolean;
  estimated_tokens: number;
} {
  const estimated_tokens = estimateTokensFromMessages(payload);
  const messagesUnknown = payload.messages;

  if (!Array.isArray(messagesUnknown)) {
    return { triggered: false, estimated_tokens };
  }

  if (estimated_tokens <= 20_000) {
    return { triggered: false, estimated_tokens };
  }

  const systemInstruction =
    "Summarize the preceding context strictly to active technical tasks and discard resolved conversation history.";

  (messagesUnknown as unknown[]).unshift({
    role: "system",
    content: systemInstruction
  });

  return { triggered: true, estimated_tokens };
}

function getRequiredIncomingHeader(
  req: http.IncomingMessage,
  name: "x-api-key" | "anthropic-version" | "content-type"
): string | null {
  const v = req.headers[name];
  if (typeof v === "string" && v.trim().length) return v.trim();
  return null;
}

function forwardHeaders(req: http.IncomingMessage): Record<string, string> {
  const xApiKey = getRequiredIncomingHeader(req, "x-api-key");
  const anthropicVersion = getRequiredIncomingHeader(req, "anthropic-version");
  const contentType = getRequiredIncomingHeader(req, "content-type");

  if (!xApiKey) throw new Error("Missing required header: x-api-key");
  if (!anthropicVersion) throw new Error("Missing required header: anthropic-version");
  if (!contentType) throw new Error("Missing required header: content-type");

  const headers: Record<string, string> = {
    "x-api-key": xApiKey,
    "anthropic-version": anthropicVersion,
    "content-type": contentType,
    accept: "text/event-stream"
  };

  const beta = req.headers["anthropic-beta"];
  if (typeof beta === "string" && beta.trim().length) headers["anthropic-beta"] = beta.trim();

  return headers;
}

type UsageLike = {
  input_tokens?: unknown;
  output_tokens?: unknown;
};

function extractUsageFromEventJson(obj: unknown): { input?: number; output?: number } | null {
  if (!obj || typeof obj !== "object") return null;

  const rec = obj as Record<string, unknown>;
  const usage = rec.usage as UsageLike | undefined;
  if (!usage || typeof usage !== "object") return null;

  const input =
    typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : undefined;
  const output =
    typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : undefined;

  if (input === undefined && output === undefined) return null;
  return { input, output };
}

export async function startProxyServer(opts: ProxyOptions): Promise<void> {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (isAnthropicApiRequest(req)) {
      try {
        const { raw, json } = await readJsonBody(req);
        if (raw.length !== 0 && json === null) {
          // eslint-disable-next-line no-console
          console.log(chalk.yellowBright("warning: body was not valid JSON"));
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }

        const body = (json ?? null) as AnthropicMessagesRequest | null;
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "missing_body" }));
          return;
        }

        const compact = maybeAutoCompact(body);
        if (compact.triggered) {
          // eslint-disable-next-line no-console
          console.warn(
            chalk.yellowBright(
              `Auto-compacting triggered: ${compact.estimated_tokens} tokens detected.`
            )
          );
        }

        const routed = routePayload(body);
        const { original_model, routed_model, reason } = routed.decision;
        const payload = routed.payload as AnthropicMessagesRequest;

        payload.stream = true;

        // eslint-disable-next-line no-console
        console.log(
          [
            chalk.magentaBright("anthropic request"),
            chalk.gray(req.method ?? "POST"),
            chalk.gray(req.url ?? ""),
            chalk.gray(`route=${reason}`),
            chalk.gray(`original=${original_model}`),
            chalk.gray(`routed=${routed_model}`),
            payload.max_tokens != null ? chalk.gray(`max_tokens=${String(payload.max_tokens)}`) : null
          ]
            .filter(Boolean)
            .join(" ")
        );

        // eslint-disable-next-line no-console
        console.log(chalk.gray("incoming payload: ") + chalk.whiteBright(raw.length ? raw : "(empty)"));

        const controller = new AbortController();
        req.on("close", () => controller.abort());

        const forwardUrl = "https://api.anthropic.com/v1/messages";

        let upstream: Response;
        try {
          upstream = await fetch(forwardUrl, {
            method: "POST",
            headers: forwardHeaders(req),
            body: JSON.stringify(payload),
            signal: controller.signal
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(msg);
          return;
        }

        if (!upstream.ok) {
          const errorBody = await upstream.text().catch(() => "");
          res.statusCode = upstream.status;
          res.setHeader(
            "content-type",
            upstream.headers.get("content-type") ?? "text/plain"
          );
          res.end(errorBody);
          return;
        }

        res.statusCode = upstream.status;
        res.setHeader(
          "content-type",
          upstream.headers.get("content-type") ?? "text/event-stream"
        );
        const cacheControl = upstream.headers.get("cache-control");
        if (cacheControl) res.setHeader("cache-control", cacheControl);

        if (!upstream.body) {
          res.end();
          return;
        }

        let seenInputTokens = 0;
        let seenOutputTokens = 0;
        const decoder = new TextDecoder();
        let buffer = "";

        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;

            const chunkText = decoder.decode(value, { stream: true });
            buffer += chunkText;

            // Parse SSE frames separated by blank line.
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);

              const lines = frame.split("\n");
              for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                try {
                  const obj = JSON.parse(data) as unknown;
                  const usage = extractUsageFromEventJson(obj);
                  if (usage?.input != null) seenInputTokens = usage.input;
                  if (usage?.output != null) seenOutputTokens = usage.output;
                } catch {
                  // ignore parse errors in streamed frames
                }
              }
            }

            res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }

        try {
          await addUsage({
            timestamp: new Date().toISOString(),
            original_model,
            routed_model,
            input_tokens: seenInputTokens,
            output_tokens: seenOutputTokens,
            estimated_cost: estimateCostUsd(routed_model, seenInputTokens, seenOutputTokens)
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            chalk.yellowBright("db write skipped:"),
            err instanceof Error ? err.message : String(err)
          );
        }

        return;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          chalk.redBright("proxy error:"),
          err instanceof Error ? err.message : String(err)
        );
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_error" }));
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => resolve());
  });

  // eslint-disable-next-line no-console
  console.log(chalk.greenBright(`proxy listening on http://localhost:${opts.port}`));
}

