import { createFileRoute } from "@tanstack/react-router";
import { runTool } from "@/lib/mv-tools";
import { isOffTopic, isPromptInjection, sanitizeUserText } from "@/lib/mv-security";

const MAX_CATALOG_BODY_BYTES = 4_000;

export const Route = createFileRoute("/api/catalog")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        return searchCatalog({
          query: url.searchParams.get("query") || "",
          minPrice: url.searchParams.get("minPrice"),
          maxPrice: url.searchParams.get("maxPrice"),
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        });
      },
      POST: async ({ request }: { request: Request }) => {
        const body = await readLimitedJson<{
          query?: unknown;
          minPrice?: unknown;
          maxPrice?: unknown;
          offset?: unknown;
          limit?: unknown;
        }>(request, MAX_CATALOG_BODY_BYTES);
        return searchCatalog(body);
      },
    },
  },
});

async function searchCatalog(input: {
  query?: unknown;
  minPrice?: unknown;
  maxPrice?: unknown;
  offset?: unknown;
  limit?: unknown;
}): Promise<Response> {
  const query = sanitizeUserText(String(input.query || ""), 240);
  if (!query) return json({ products: [], error: "Empty query" }, 400);
  if (isPromptInjection(query) || isOffTopic(query)) return json({ products: [] });

  const result = await runTool("search_catalog", {
    query,
    minPrice: numberOrUndefined(input.minPrice),
    maxPrice: numberOrUndefined(input.maxPrice),
    offset: numberOrUndefined(input.offset),
    limit: numberOrUndefined(input.limit),
  });
  if ("products" in result) {
    return json({ products: result.products, source: result.source, page: result.page });
  }
  return json({ products: [], error: "error" in result ? result.error : "Catalog error" }, 200);
}

async function readLimitedJson<T>(request: Request, maxBytes: number): Promise<T> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("Request body too large");

  const text = await request.text();
  if (text.length > maxBytes) throw new Error("Request body too large");
  return JSON.parse(text) as T;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
