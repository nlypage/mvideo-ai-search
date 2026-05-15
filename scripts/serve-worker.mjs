import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import worker from "../dist/server/index.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const backendOrigin = (process.env.BACKEND_ORIGIN || "").replace(/\/$/, "");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = resolve(appDir, "dist/client");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function safeAssetPath(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const normalized = normalize(decoded).replace(/^([/\\])+/, "");
  const filePath = resolve(join(clientDir, normalized));
  if (!filePath.startsWith(`${clientDir}/`) && filePath !== clientDir) return null;
  return filePath;
}

function sendFile(res, filePath, pathname) {
  res.statusCode = 200;
  res.setHeader("content-type", contentTypes[extname(filePath)] || "application/octet-stream");
  res.setHeader(
    "cache-control",
    pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
  );
  createReadStream(filePath).pipe(res);
}

function findStaticAsset(pathname) {
  const assetPath = safeAssetPath(pathname);
  if (assetPath && existsSync(assetPath) && statSync(assetPath).isFile()) {
    return assetPath;
  }

  if (pathname === "/favicon.ico") {
    const svgFaviconPath = safeAssetPath("/favicon.svg");
    if (svgFaviconPath && existsSync(svgFaviconPath) && statSync(svgFaviconPath).isFile()) {
      return svgFaviconPath;
    }
  }

  return null;
}

async function sendNodeResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function apiProxyHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (
      [
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
      ].includes(lower)
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else {
      headers.set(key, value);
    }
  }
  headers.set("x-forwarded-host", req.headers.host || "");
  headers.set("x-forwarded-proto", "http");
  if (req.socket.remoteAddress) headers.set("x-forwarded-for", req.socket.remoteAddress);
  return headers;
}

async function proxyAPIRequest(req, res, url) {
  const target = new URL(`${url.pathname}${url.search}`, backendOrigin);
  const body = await readRequestBody(req);
  const response = await fetch(target, {
    method: req.method,
    headers: apiProxyHeaders(req),
    body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
  });
  await sendNodeResponse(res, response);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
    if (backendOrigin && (url.pathname === "/api" || url.pathname.startsWith("/api/"))) {
      await proxyAPIRequest(req, res, url);
      return;
    }

    const staticAssetPath = findStaticAsset(url.pathname);
    if (staticAssetPath) {
      sendFile(res, staticAssetPath, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/assets/")) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Asset not found");
      return;
    }

    const body = await readRequestBody(req);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });
    const response = await worker.fetch(request, process.env, {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    });
    await sendNodeResponse(res, response);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  }
});

server.listen(port, host, () => {
  console.log(`Server ready on http://${host}:${port}`);
});
