// 1. ALLOWED ORIGINS (Whitelist)
const ALLOWED_WEB_ORIGINS = [
  "https://flameipt3.vercel.app",
  "https://streamzlite.vercel.app"
];

function checkOrigin(req: Request): { allowed: boolean; origin: string } {
  const originHeader = req.headers.get("origin") || req.headers.get("referer");
  if (!originHeader) return { allowed: false, origin: "null" };

  try {
    const originUrl = new URL(originHeader).origin;
    if (ALLOWED_WEB_ORIGINS.includes(originUrl)) return { allowed: true, origin: originUrl };
    
    // Capacitor / Mobile App allowlist
    if (
      originUrl.startsWith("http://localhost") ||
      originUrl.startsWith("https://localhost") ||
      originUrl.startsWith("capacitor://") ||
      originUrl.startsWith("app://") ||
      originUrl === "file://"
    ) {
      return { allowed: true, origin: originUrl };
    }
  } catch (_e) {
    // Huwag mag-crash kung hindi valid URL ang nasa header
  }

  return { allowed: false, origin: "null" };
}

function getCorsHeaders(allowedOrigin: string) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range, x-forwarded-for, x-real-ip",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges",
  };
}

const DEFAULT_UA = "VLC/3.0.18 LibVLC/3.0.18"; // Mas maganda itong UA para sa HTTP IPTV streams
const MAX_REDIRECTS = 5;

function buildUpstreamHeaders(req: Request, params: URLSearchParams): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": params.get("ua") || DEFAULT_UA };
  const referer = params.get("referer");
  if (referer) {
    headers["Referer"] = referer;
    try { headers["Origin"] = new URL(referer).origin; } catch (_e) {}
  }
  
  if (params.has("cookie")) headers["Cookie"] = params.get("cookie") as string;
  if (params.has("auth")) headers["Authorization"] = params.get("auth") as string;
  
  const range = req.headers.get("Range");
  if (range) headers["Range"] = range; 

  // IP FORWARDING: Para hindi ma-IP Ban ang proxy server mo sa mga IPTV providers
  const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip");
  if (clientIp) {
    headers["X-Forwarded-For"] = clientIp;
    headers["X-Real-IP"] = clientIp;
  }
  
  return headers;
}

function extraParams(params: URLSearchParams): string {
  let extra = "";
  for (const key of ["ua", "referer", "cookie", "auth"]) {
    const val = params.get(key);
    if (val) extra += `&${key}=${encodeURIComponent(val)}`;
  }
  return extra;
}

async function fetchWithRedirects(url: string, headers: Record<string, string>, method = "GET", body?: ReadableStream | null): Promise<Response> {
  let current = url;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (i === 0 && body && method === "POST") {
      init.body = body;
      (init as any).duplex = "half"; 
    }
    
    const resp = await fetch(current, init);
    const location = resp.headers.get("location");
    if (location && resp.status >= 300 && resp.status < 400) {
      current = location.startsWith("http") ? location : new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  return fetch(current, { method, headers });
}

function rewriteHLS(text: string, baseUrl: string, proxyBase: string, extra: string): string {
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/g, (_m, uri) => {
        const full = uri.startsWith("http") ? uri : baseUrl + uri;
        return `URI="${proxyBase}${encodeURIComponent(full)}${extra}"`;
      });
    }
    if (trimmed && !trimmed.startsWith("#")) {
      const full = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
      return proxyBase + encodeURIComponent(full) + extra;
    }
    return line;
  }).join("\n");
}

function rewriteDASH(text: string, baseUrl: string, proxyBase: string, extra: string): string {
  let rewritten = text;
  rewritten = rewritten.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_m, innerUrl) => {
    const full = innerUrl.startsWith("http") ? innerUrl : baseUrl + innerUrl;
    return `<BaseURL>${proxyBase}${encodeURIComponent(full)}${extra}</BaseURL>`;
  });
  rewritten = rewritten.replace(/(media|initialization)="([^"]+)"/g, (match, attr, val) => {
    if (val.includes("$")) return match;
    const full = val.startsWith("http") ? val : baseUrl + val;
    return `${attr}="${proxyBase}${encodeURIComponent(full)}${extra}"`;
  });
  return rewritten;
}

// --- PANG RAILWAY FIX ---
// Kinukuha natin ang PORT na binibigay ng Railway. Kung wala, gagamit ito ng port 8080.
const PORT = Number(Deno.env.get("PORT")) || 8080;

Deno.serve({ port: PORT }, async (req) => {
  const { allowed, origin: requestOrigin } = checkOrigin(req);
  const corsHeaders = getCorsHeaders(requestOrigin);

  if (!allowed) {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders, status: 204 });
    return new Response(JSON.stringify({ error: "Access Denied" }), { status: 403, headers: corsHeaders });
  }

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const params = url.searchParams;
    const targetUrl = params.get("url");

    if (!targetUrl) {
      return new Response("Missing 'url'", { status: 400, headers: corsHeaders });
    }

    const upstreamHeaders = buildUpstreamHeaders(req, params);

    if (req.method === "POST") {
      const clientCT = req.headers.get("content-type");
      if (clientCT) upstreamHeaders["Content-Type"] = clientCT;
      const resp = await fetchWithRedirects(targetUrl, upstreamHeaders, "POST", req.body);
      
      return new Response(resp.body, {
        status: resp.status,
        headers: { ...corsHeaders, "Content-Type": resp.headers.get("content-type") || "application/octet-stream" },
      });
    }

    const response = await fetchWithRedirects(targetUrl, upstreamHeaders, "GET");
    if (!response.ok && response.status !== 206) {
      return new Response(`Upstream Error: ${response.status}`, { status: response.status, headers: corsHeaders });
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const isHLS = targetUrl.includes(".m3u8") || contentType.includes("mpegurl");
    const isDASH = targetUrl.includes(".mpd") || contentType.includes("dash+xml");

    if (isHLS || isDASH) {
      const text = await response.text();
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      const proxyBase = `${url.origin}${url.pathname}?url=`;
      const extra = extraParams(params);
      
      const rewritten = isHLS ? rewriteHLS(text, baseUrl, proxyBase, extra) : rewriteDASH(text, baseUrl, proxyBase, extra);
      
      return new Response(rewritten, {
        status: response.status,
        headers: { 
          ...corsHeaders, 
          "Content-Type": isHLS ? "application/vnd.apple.mpegurl" : "application/dash+xml", 
          "Cache-Control": "no-store" 
        },
      });
    }

    // PARA SA VIDEO/HTTP STREAMS
    const respHeaders: Record<string, string> = { 
      ...corsHeaders, 
      "Content-Type": contentType,
    };
    
    // Check kung VOD ba ito o Live HTTP Stream (IPTV)
    const cl = response.headers.get("content-length");
    if (cl) {
      respHeaders["Content-Length"] = cl;
      respHeaders["Cache-Control"] = "public, max-age=3600";
    } else {
      respHeaders["Cache-Control"] = "no-store, no-cache, must-revalidate";
    }

    const cr = response.headers.get("content-range");
    if (cr) respHeaders["Content-Range"] = cr;
    
    const ar = response.headers.get("accept-ranges");
    if (ar) respHeaders["Accept-Ranges"] = ar;

    return new Response(response.body, { status: response.status, headers: respHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: corsHeaders });
  }
});
