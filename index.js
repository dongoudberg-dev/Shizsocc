const USERNAME_RE = /^[a-zA-Z0-9_]{1,20}$/;
const RESERVED = new Set(["owner", "admin", "api", "www", "support", "help"]);
const ACCENTS = new Set(["#a855f7", "#ec4899", "#3b82f6", "#14b8a6", "#f97316", "#e5e7eb"]);
const BACKGROUNDS = new Set(["aurora", "midnight", "sunset", "ocean"]);

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const keyOf = (v) => String(v ?? "").trim().toLowerCase();

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function bytesToB64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function b64UrlToBytes(value) {
  const base = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base + "=".repeat((4 - base.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
async function makeOwnerCookie(secret) {
  const payload = bytesToB64Url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000, nonce: crypto.randomUUID() })));
  return payload + "." + bytesToB64Url(await hmac(payload, secret));
}
async function isOwner(request, secret) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)ss_owner=([^;]+)/);
  if (!match) return false;
  const parts = match[1].split(".");
  if (parts.length !== 2) return false;
  try {
    const expected = await hmac(parts[0], secret);
    const actual = b64UrlToBytes(parts[1]);
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
    if (diff !== 0) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(parts[0])));
    return payload.exp > Date.now();
  } catch { return false; }
}
const ownerCookie = (value, maxAge = 28800) =>
  `ss_owner=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function getProfile(db, username) {
  return db.prepare("SELECT * FROM profiles WHERE username_key = ?").bind(keyOf(username)).first();
}
function publicProfile(row) {
  return {
    username: row.username, displayName: row.display_name, bio: row.bio,
    avatarUrl: row.avatar_url, accent: row.accent, background: row.background,
    links: JSON.parse(row.links_json || "[]"), views: row.views, createdAt: row.created_at
  };
}
async function ownerOnly(request, env) {
  return isOwner(request, env.OWNER_SECRET);
}
async function routeApi(request, env, url) {
  const method = request.method;
  const path = url.pathname;

  if (path === "/api/health" && method === "GET") return json({ ok: true, platform: "cloudflare-workers-d1" });

  if (path === "/api/claim" && method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const username = clean(body.username, 100);
    if (!USERNAME_RE.test(username)) return json({ error: "Username must be 1–20 characters: letters, numbers and underscores only." }, 400);
    const usernameKey = keyOf(username);
    if (RESERVED.has(usernameKey)) return json({ error: "That username is reserved." }, 409);
    const editToken = bytesToB64Url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256(editToken);
    try {
      await env.DB.prepare("INSERT INTO profiles (username, username_key, display_name, edit_token_hash) VALUES (?, ?, ?, ?)")
        .bind(username, usernameKey, username, tokenHash).run();
      return json({ username, editToken }, 201);
    } catch (error) {
      if (String(error).includes("UNIQUE") || String(error).includes("constraint")) return json({ error: "That username has already been claimed." }, 409);
      console.error(error);
      return json({ error: "Could not claim username. Please try again." }, 500);
    }
  }

  if (path === "/api/profiles-public" && method === "GET") {
    const result = await env.DB.prepare("SELECT username, display_name, bio FROM profiles ORDER BY created_at DESC LIMIT 60").all();
    return json(result.results.map(r => ({ username: r.username, displayName: r.display_name, bio: r.bio })));
  }

  if (path.startsWith("/api/profile/")) {
    const username = decodeURIComponent(path.slice("/api/profile/".length));
    const row = await getProfile(env.DB, username);
    if (!row) return json({ error: "Profile not found." }, 404);
    if (method === "GET") {
      await env.DB.prepare("UPDATE profiles SET views = views + 1 WHERE id = ?").bind(row.id).run();
      const fresh = await getProfile(env.DB, username);
      return json(publicProfile(fresh));
    }
    if (method === "PUT") {
      const token = request.headers.get("X-Edit-Token") || "";
      if (!token || await sha256(token) !== row.edit_token_hash) return json({ error: "Invalid profile edit key." }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
      const display = clean(body.displayName || row.username, 40) || row.username;
      const bio = clean(body.bio, 160);
      const avatar = clean(body.avatarUrl, 500);
      if (avatar && !/^https:\/\/\S+$/i.test(avatar)) return json({ error: "Avatar must be an HTTPS URL." }, 400);
      const accent = ACCENTS.has(body.accent) ? body.accent : row.accent;
      const background = BACKGROUNDS.has(body.background) ? body.background : row.background;
      const links = Array.isArray(body.links) ? body.links.slice(0, 8).map(item => {
        const title = clean(item.title, 32);
        try {
          const parsed = new URL(String(item.url || ""));
          if (!title || !["http:", "https:"].includes(parsed.protocol)) return null;
          return { title, url: parsed.href };
        } catch { return null; }
      }).filter(Boolean) : [];
      await env.DB.prepare("UPDATE profiles SET display_name=?, bio=?, avatar_url=?, accent=?, background=?, links_json=? WHERE id=?")
        .bind(display, bio, avatar, accent, background, JSON.stringify(links), row.id).run();
      return json(publicProfile(await getProfile(env.DB, username)));
    }
  }

  if (path === "/api/owner/login" && method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const supplied = String(body.password || "");
    if (!env.OWNER_PASSWORD || supplied !== env.OWNER_PASSWORD) return json({ error: "Incorrect password." }, 401);
    if (!env.OWNER_SECRET || env.OWNER_SECRET.length < 32) return json({ error: "Owner session secret is not configured correctly." }, 500);
    const cookie = await makeOwnerCookie(env.OWNER_SECRET);
    return json({ ok: true }, 200, { "set-cookie": ownerCookie(cookie) });
  }
  if (path === "/api/owner/logout" && method === "POST") {
    if (!await ownerOnly(request, env)) return json({ error: "Owner login required." }, 401);
    return json({ ok: true }, 200, { "set-cookie": ownerCookie("", 0) });
  }
  if (path === "/api/owner/me" && method === "GET") return json({ owner: await ownerOnly(request, env) });

  if (path.startsWith("/api/owner/")) {
    if (!await ownerOnly(request, env)) return json({ error: "Owner login required." }, 401);
    if (path === "/api/owner/profiles" && method === "GET") {
      const result = await env.DB.prepare("SELECT * FROM profiles ORDER BY created_at DESC").all();
      return json(result.results.map(publicProfile));
    }
    const match = path.match(/^\/api\/owner\/profiles\/([^/]+)$/);
    if (match) {
      const username = decodeURIComponent(match[1]);
      const row = await getProfile(env.DB, username);
      if (!row) return json({ error: "Profile not found." }, 404);
      if (method === "PATCH") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
        const display = clean(body.displayName ?? row.display_name, 40) || row.username;
        const bio = clean(body.bio ?? row.bio, 160);
        const views = Number.isSafeInteger(Number(body.views)) && Number(body.views) >= 0 ? Number(body.views) : row.views;
        await env.DB.prepare("UPDATE profiles SET display_name=?, bio=?, views=? WHERE id=?").bind(display, bio, views, row.id).run();
        return json(publicProfile(await getProfile(env.DB, username)));
      }
      if (method === "DELETE") {
        await env.DB.prepare("DELETE FROM profiles WHERE id=?").bind(row.id).run();
        return json({ ok: true });
      }
    }
  }
  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await routeApi(request, env, url); }
      catch (error) { console.error(error); return json({ error: "Server error. Check your Worker logs." }, 500); }
    }
    if (url.pathname === "/owner") return env.ASSETS.fetch(new Request(new URL("/owner.html", request.url), request));
    if (url.pathname.startsWith("/u/")) return env.ASSETS.fetch(new Request(new URL("/profile.html", request.url), request));
    return env.ASSETS.fetch(request);
  }
};
