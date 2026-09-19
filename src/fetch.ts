/**
 * HTTP for manifests.
 *
 * A diagnostic tool points at whatever URL it is given, which is frequently a
 * broken one, so every request is bounded: a timeout, a body cap, and a
 * redirect cap. An MCP server that hangs is worse than one that reports a
 * timeout, because the caller is an agent that will simply wait.
 */

export interface FetchOptions {
  timeoutMs?: number;
  /** Extra request headers, for CDN tokens or an Origin the CDN expects. */
  headers?: Record<string, string>;
  /** Refuse bodies larger than this. Manifests are text; megabytes mean a mistake. */
  maxBytes?: number;
}

export interface FetchResult {
  url: string;
  /** Final URL after redirects, which is itself diagnostic. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Wall-clock milliseconds, useful when the complaint is "it is slow". */
  elapsedMs: number;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Identifying the tool is deliberate. Origins and CDNs log user agents, and an
 * engineer debugging their own stream should be able to see these requests in
 * their access logs and tell them apart from real players.
 */
const USER_AGENT = "streamprobe-mcp/0.1 (+https://github.com/CodeDTX/streamprobe-mcp)";

export async function fetchText(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchError(`Not a URL: ${url}`, url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchError(`Only http and https are supported, got ${parsed.protocol}`, url);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(parsed, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "*/*", ...(options.headers ?? {}) },
    });

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      throw new FetchError(
        `Body is ${declared} bytes, over the ${maxBytes} cap. This does not look like a manifest.`,
        url,
        res.status,
      );
    }

    const body = await res.text();
    if (body.length > maxBytes) {
      throw new FetchError(`Body exceeded the ${maxBytes} byte cap`, url, res.status);
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      headers,
      body,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof FetchError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new FetchError(`Timed out after ${timeoutMs}ms`, url);
    }
    throw new FetchError(error instanceof Error ? error.message : String(error), url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Availability probe for segments.
 *
 * HEAD first because a segment can be megabytes and the question is only
 * whether it is there. Some CDNs answer 405 to HEAD while serving GET fine, so
 * that one case falls back to a ranged GET rather than being reported as a
 * missing segment, which would be a false alarm on an otherwise healthy stream.
 */
export async function probeUrl(
  url: string,
  options: FetchOptions = {},
): Promise<{ url: string; status: number; ok: boolean; elapsedMs: number; method: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;

  async function attempt(method: "HEAD" | "GET"): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          ...(method === "GET" ? { range: "bytes=0-1" } : {}),
          ...(options.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const started = Date.now();
  try {
    let method: "HEAD" | "GET" = "HEAD";
    let res = await attempt(method);
    if (res.status === 405 || res.status === 501) {
      method = "GET";
      res = await attempt(method);
    }
    return {
      url,
      status: res.status,
      ok: res.ok || res.status === 206,
      elapsedMs: Date.now() - started,
      method,
    };
  } catch (error) {
    return {
      url,
      status: 0,
      ok: false,
      elapsedMs: Date.now() - started,
      method: error instanceof Error && error.name === "AbortError" ? "timeout" : "error",
    };
  }
}

/** Resolves a manifest-relative URI against the document it came from. */
export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}
