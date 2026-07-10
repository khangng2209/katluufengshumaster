#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(process.env.NCE_ROOT || process.cwd());
const port = Number(process.env.PORT || 4174);
const manifest = JSON.parse(await readFile(join(root, "framer-live.json"), "utf8"));
const sourceOrigin = new URL(manifest.sourceOrigin).origin;
const routeMetadata = manifest.routeMetadata || {};
const prefixes = [...new Set([...(manifest.cmsRoutePrefixes || []), ...(manifest.localizedCmsRoutePrefixes || [])])];
const livePages = new Set(manifest.livePagePaths || manifest.cmsPagePaths || []);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function isLiveRoutePath(pathname) {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return livePages.has(normalized) || prefixes.some((prefix) => normalized.startsWith(prefix + "/"));
}

function localPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const segments = decoded.split("/").filter((segment) => segment && segment !== "." && segment !== "..");
  return join(root, ...segments);
}

function stripFramerChrome(html) {
  const cleaned = html.replace(/<!--[sS]*?Made in Framer[sS]*?-->/gi, "");
  const guard = '<style id="nce-framer-chrome-guard">#__framer-editorbar-button,.framer-6jWyo,.framer-n0ccwk,.framer-v-n0ccwk,.framer-bmpgw8,.__framer-badge,[class*="framer-badge"],[id*="framer-badge"],[data-framer-badge],[href*="framer.com"][aria-label*="Made"]{display:none!important;visibility:hidden!important;pointer-events:none!important}</style>';
  return cleaned.includes("</head>") ? cleaned.replace("</head>", guard + "</head>") : cleaned;
}

function rewriteSourceOrigin(body, targetOrigin) {
  const escapedSource = sourceOrigin.split("/").join("\\/");
  const escapedTarget = targetOrigin.split("/").join("\\/");
  return body
    .replaceAll(sourceOrigin, targetOrigin)
    .replaceAll(escapedSource, escapedTarget);
}

function normalizedMetadataPath(pathname) {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return normalized || "/";
}

function escapeHtmlText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttr(value) {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}

function metadataUrl(value, targetOrigin) {
  if (!value) return "";
  const rewritten = String(value).replaceAll(sourceOrigin, targetOrigin);
  try {
    return new URL(rewritten, targetOrigin).href;
  } catch {
    return rewritten;
  }
}

function removeManagedMetadata(html) {
  return html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, "")
    .replace(/<meta\b(?=[^>]*(?:name|property)=["'](?:description|og:[^"']+|twitter:[^"']+)["'])[^>]*>/gi, "")
    .replace(/<link\b(?=[^>]*rel=["']canonical["'])[^>]*>/gi, "");
}

function injectRouteMetadata(html, pathname, targetOrigin) {
  if (!/<\/head>/i.test(html)) return html;

  const path = normalizedMetadataPath(pathname);
  const metadata = routeMetadata[path];
  if (!metadata || (!metadata.title && !metadata.description && !metadata.image)) return html;

  const canonical = targetOrigin + (path === "/" ? "/" : path);
  const title = metadata.title || "";
  const description = metadata.description || "";
  const image = metadataUrl(metadata.image || "", targetOrigin);
  const type = metadata.type || "website";
  const tags = [];

  if (title) tags.push("<title>" + escapeHtmlText(title) + "</title>");
  if (description) tags.push('<meta name="description" content="' + escapeHtmlAttr(description) + '">');
  tags.push('<link rel="canonical" href="' + escapeHtmlAttr(canonical) + '">');
  if (title) tags.push('<meta property="og:title" content="' + escapeHtmlAttr(title) + '">');
  if (description) tags.push('<meta property="og:description" content="' + escapeHtmlAttr(description) + '">');
  tags.push('<meta property="og:type" content="' + escapeHtmlAttr(type) + '">');
  tags.push('<meta property="og:url" content="' + escapeHtmlAttr(canonical) + '">');
  if (image) tags.push('<meta property="og:image" content="' + escapeHtmlAttr(image) + '">');
  tags.push('<meta name="twitter:card" content="' + (image ? "summary_large_image" : "summary") + '">');
  if (title) tags.push('<meta name="twitter:title" content="' + escapeHtmlAttr(title) + '">');
  if (description) tags.push('<meta name="twitter:description" content="' + escapeHtmlAttr(description) + '">');
  if (image) tags.push('<meta name="twitter:image" content="' + escapeHtmlAttr(image) + '">');

  return removeManagedMetadata(html).replace(/<\/head>/i, tags.join("") + "</head>");
}

function rewriteLiveBody(body, contentType, targetOrigin, pathname) {
  const rewritten = rewriteSourceOrigin(body, targetOrigin);
  if (!/text\/html/i.test(contentType)) return rewritten;
  return stripFramerChrome(injectRouteMetadata(rewritten, pathname, targetOrigin));
}

function fallbackRobots(targetOrigin) {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Sitemap: " + targetOrigin + "/sitemap.xml",
    "",
  ].join("\n");
}

async function readStatic(pathname) {
  const base = localPath(pathname);
  const candidates = pathname.endsWith("/")
    ? [join(base, "index.html")]
    : [base, join(base, "index.html")];

  for (const candidate of candidates) {
    if (!candidate.startsWith(root)) continue;
    try {
      if ((await stat(candidate)).isFile()) return { path: candidate, body: await readFile(candidate) };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function proxyFramer(req, res, requestUrl) {
  const upstream = new URL(requestUrl.pathname + requestUrl.search, sourceOrigin);
  const headers = {
    accept: req.headers.accept || "text/html,application/xhtml+xml",
    "cache-control": "no-cache",
    pragma: "no-cache",
  };
  const response = await fetch(upstream, { headers, redirect: "follow", cache: "no-store" });
  const contentType = response.headers.get("content-type") || "text/html; charset=utf-8";
  let body = await response.text();
  const host = req.headers.host || "localhost:" + port;
  const localOrigin = "http://" + host;
  const upstreamFailedRobots = requestUrl.pathname === "/robots.txt" && response.status >= 400;
  if (upstreamFailedRobots) {
    body = fallbackRobots(localOrigin);
  } else {
    body = rewriteLiveBody(body, contentType, localOrigin, requestUrl.pathname);
  }

  res.writeHead(upstreamFailedRobots ? 200 : response.status, {
    "content-type": requestUrl.pathname === "/robots.txt" && response.status >= 400 ? "text/plain; charset=utf-8" : contentType,
    "cache-control": "no-store",
    "x-nocodeexport-framer-live": "1",
    "x-nocodeexport-source": upstream.origin,
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || "localhost:" + port;
    const requestUrl = new URL(req.url || "/", "http://" + host);
    const file = await readStatic(requestUrl.pathname);
    if (file) {
      res.writeHead(200, {
        "content-type": mime[extname(file.path).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(file.body);
      return;
    }

    if (isLiveRoutePath(requestUrl.pathname)) {
      await proxyFramer(req, res, requestUrl);
      return;
    }

    const notFound = await readStatic("/404.html");
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(notFound?.body || "404 Not Found");
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("Framer live request failed: " + (error instanceof Error ? error.message : String(error)));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`NoCodeExport Framer live preview: http://127.0.0.1:${port}`);
  console.log(`Detected dynamic prefixes: ${prefixes.join(", ") || "none"}`);
  console.log(`Live exported routes: ${[...livePages].join(", ") || "none"}`);
});
