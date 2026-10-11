// Validasi & konversi link TikTok -> URL versi web (https://www.tiktok.com/@user/video/ID)
// Urutan: cek format -> ikuti redirect link pendek (vt/vm) -> verifikasi ke TikWM -> cadangan oEmbed TikTok.
"use strict";

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

const TIMEOUT_MS = 8000;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 500;

const CANON_RE = /^\/@([\w.\-]+)\/(video|photo)\/(\d{8,25})\/?$/;
const LOOSE_ID_RE = /\/(?:video|v|embed\/v2)\/(\d{8,25})/;

const cache = new Map();

const isTikTokHost = (h) => h === "tiktok.com" || h.endsWith(".tiktok.com");
const canon = (user, id) => `https://www.tiktok.com/@${user}/video/${id}`;

function parseInput(raw) {
  let s = String(raw || "").trim();
  if (!s) return { error: "Link video wajib diisi" };
  if (s.length > 500) return { error: "Link terlalu panjang" };
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return { error: "Format link tidak valid" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Format link tidak valid" };
  if (!isTikTokHost(u.hostname.toLowerCase())) return { error: "Link harus berasal dari tiktok.com" };
  return { url: u };
}

// Ambil user/id/kind dari path kalau sudah berbentuk link web.
function fromPath(u) {
  const m = CANON_RE.exec(u.pathname);
  if (m) return { user: m[1], kind: m[2], id: m[3] };
  const l = LOOSE_ID_RE.exec(u.pathname);
  if (l) return { user: null, kind: "video", id: l[1] };
  return null;
}

async function getJson(fetchFn, url, headers) {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// Ikuti redirect link pendek (vt./vm./tiktok.com/t/...) tanpa keluar dari domain tiktok.com.
async function resolveShort(fetchFn, u) {
  let cur = u;
  for (let i = 0; i < 5; i++) {
    let res;
    try {
      res = await fetchFn(cur.href, {
        redirect: "manual",
        headers: { "user-agent": UA_MOBILE, accept: "text/html" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { return null; }
    const loc = res.headers && res.headers.get && res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      let next;
      try { next = new URL(loc, cur); } catch { return null; }
      if (!isTikTokHost(next.hostname.toLowerCase())) return null;
      cur = next;
      if (fromPath(cur) && fromPath(cur).user) return cur;
      continue;
    }
    return cur;
  }
  return cur;
}

async function verifyTikwm(fetchFn, target) {
  try {
    const { json } = await getJson(fetchFn, `https://www.tikwm.com/api/?url=${encodeURIComponent(target)}&hd=0`, { "user-agent": UA_DESKTOP });
    if (!json) return { state: "unavailable" };
    if (json.code === 0 && json.data && json.data.id) {
      const d = json.data;
      return {
        state: "valid",
        id: String(d.id),
        user: d.author && d.author.unique_id,
        title: d.title || "",
        cover: d.cover || d.origin_cover || "",
        isPhoto: Array.isArray(d.images) && d.images.length > 0,
      };
    }
    const msg = String(json.msg || "").toLowerCase();
    if (/limit|too many|frequen|busy|try again/.test(msg)) return { state: "unavailable" };
    return { state: "invalid" };
  } catch { return { state: "unavailable" }; }
}

async function verifyOembed(fetchFn, target) {
  try {
    const { status, json } = await getJson(fetchFn, `https://www.tiktok.com/oembed?url=${encodeURIComponent(target)}`, { "user-agent": UA_DESKTOP, accept: "application/json" });
    if (status === 200 && json && json.html) {
      const idm = /data-video-id="(\d+)"/.exec(json.html);
      const um = /tiktok\.com\/@([\w.\-]+)/.exec(json.author_url || "") || null;
      return { state: "valid", id: idm && idm[1], user: json.author_unique_id || (um && um[1]), title: json.title || "", cover: json.thumbnail_url || "", isPhoto: false };
    }
    if (status === 400 || status === 404 || (status === 200 && json)) return { state: "invalid" };
    return { state: "unavailable" };
  } catch { return { state: "unavailable" }; }
}

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), value });
}

const NOT_VIDEO = "Link ini tidak mengarah ke video TikTok yang valid (video tidak ditemukan, privat, atau sudah dihapus)";

async function resolveVideo(raw, fetchFn = globalThis.fetch) {
  const p = parseInput(raw);
  if (p.error) return { ok: false, error: p.error };

  const key = p.url.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.value;

  let local = fromPath(p.url);
  if (!local || !local.user) {
    const r = await resolveShort(fetchFn, p.url);
    const lp = r && fromPath(r);
    if (lp) local = lp;
  }
  if (local && local.kind === "photo") return { ok: false, error: "Link ini adalah foto/slideshow, bukan video" };

  const target = local && local.user ? canon(local.user, local.id) : p.url.href;

  let v = await verifyTikwm(fetchFn, target);
  if (v.state === "unavailable" && local && local.id) {
    const o = await verifyOembed(fetchFn, target);
    if (o.state !== "unavailable") v = o;
  }

  let result;
  if (v.state === "valid") {
    const id = v.id || (local && local.id);
    const user = v.user || (local && local.user);
    if (v.isPhoto) result = { ok: false, error: "Link ini adalah foto/slideshow, bukan video" };
    else if (!id || !user) result = { ok: false, error: NOT_VIDEO };
    else result = { ok: true, url: canon(user, id), id, user, title: v.title, cover: v.cover, verified: true };
  } else if (v.state === "invalid") {
    result = { ok: false, error: NOT_VIDEO };
  } else if (local && local.user && local.kind === "video") {
    // Layanan verifikasi sedang tidak bisa dihubungi, tapi link sudah berbentuk link web: lanjutkan tanpa verifikasi.
    return { ok: true, url: canon(local.user, local.id), id: local.id, user: local.user, title: "", cover: "", verified: false };
  } else {
    return { ok: false, error: "Tidak bisa memverifikasi link saat ini, coba lagi sebentar lagi" };
  }

  if (result.ok) result.changed = result.url !== String(raw).trim();
  remember(key, result);
  return result;
}

module.exports = { resolveVideo, parseInput, fromPath };
