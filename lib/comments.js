// Cek komentar TikTok untuk layanan comments-hearts.
// Alur sama seperti script ekstraktor: koneksi langsung dulu -> kalau kena limit/gagal,
// ambil daftar proxy lalu coba bergantian (per kelompok, paralel) sampai ada yang berhasil.
// Hasil di-cache sebentar per video supaya kuota API tidak habis oleh submit berulang.
//
// Opsional (Environment Variable Vercel):
//   PROXY_API_URL = sumber daftar proxy (JSON: { data: { proxies: [{ url }] } })
"use strict";

const { execFile } = require("child_process");

const ENDPOINT = "https://api.zocialmine.com/v1/tools/tiktok/comments";
const PROXY_API =
  process.env.PROXY_API_URL ||
  "https://bmskyapis.vercel.app/api/proxy?action=scrape&protocols=http,socks4,socks5&limit=40&speedFilter=medium";
const UA = "Mozilla/5.0 (Linux; Android 13) TikTokCommentExtractor/3.0";
const CODE_MARK = "__CURL_HTTP_CODE__";

const BUDGET_MS = 22000;  // total waktu maksimum untuk satu pengecekan
const DIRECT_MS = 9000;   // batas koneksi langsung
const PROXY_MS = 8000;    // batas per proxy
const BATCH = 4;          // jumlah proxy dicoba bersamaan
const MAX_TRIES = 12;     // maksimum proxy dicoba
const CACHE_TTL = 90 * 1000;
const CACHE_MAX = 100;
const LIST_MAX = 300;     // maksimum nama yang dikirim ke browser

const PROXY_RE = /^(?:https?|socks4a?|socks5h?):\/\/[\w.\-:@%\[\]]+$/i;
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://zocialmine.com",
  Referer: "https://zocialmine.com/tools/tiktok-comments",
  "User-Agent": UA,
};

const cache = new Map();
let poolCache = { t: 0, list: [] };

const norm = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isLimit(err) {
  if (!err) return false;
  if (err.freeUsage && err.freeUsage.remaining <= 0) return true;
  if (err.httpCode === 429) return true;
  const m = String(err.message || "").toLowerCase();
  return /limit|quota|credit|exceed/.test(m);
}

function toResult(code, text) {
  let body;
  try { body = JSON.parse(text); }
  catch {
    const e = new Error("Respons bukan JSON (HTTP " + code + ")");
    e.httpCode = code;
    throw e;
  }
  if (code < 200 || code >= 300 || (body && body.status === "error")) {
    const e = new Error((body && (body.message || body.error)) || "HTTP " + code);
    e.httpCode = code;
    e.freeUsage = body && body.freeUsage;
    throw e;
  }
  return body;
}

async function direct(videoUrl, ms) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ url: videoUrl }),
    signal: AbortSignal.timeout(ms),
  });
  return toResult(res.status, await res.text());
}

// Lewat proxy memakai curl (mendukung http/socks4/socks5), sama seperti script aslinya.
function viaProxy(videoUrl, proxy, ms, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS", "--max-time", String(Math.max(2, Math.ceil(ms / 1000))),
      "-X", "POST", ENDPOINT,
      "--proxy", proxy,
      "--data-binary", JSON.stringify({ url: videoUrl }),
      "--write-out", "\n" + CODE_MARK + "%{http_code}",
    ];
    for (const [k, v] of Object.entries(HEADERS)) args.push("-H", k + ": " + v);
    execFile("curl", args, { encoding: "utf8", timeout: ms + 2000, maxBuffer: 32 * 1024 * 1024, signal }, (err, stdout) => {
      if (err && err.code === "ENOENT") {
        const e = new Error("curl tidak tersedia di server");
        e.noCurl = true;
        return reject(e);
      }
      const out = stdout || "";
      const i = out.lastIndexOf(CODE_MARK);
      const text = (i < 0 ? out : out.slice(0, i)).trim();
      const code = i < 0 ? 0 : parseInt(out.slice(i + CODE_MARK.length).trim(), 10) || 0;
      if (!text) return reject(new Error("Tidak ada respons dari proxy"));
      try { resolve(toResult(code, text)); } catch (e) { reject(e); }
    });
  });
}

async function getPool(ms) {
  if (poolCache.list.length && Date.now() - poolCache.t < 60000) return poolCache.list.slice();
  const res = await fetch(PROXY_API, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms) });
  const data = await res.json();
  const list = ((data && data.data && data.data.proxies) || [])
    .map((p) => p && p.url)
    .filter((u) => typeof u === "string" && PROXY_RE.test(u));
  poolCache = { t: Date.now(), list };
  return list.slice();
}

const simplify = (c) => ({
  cid: c.cid,
  text: c.text || "",
  username: (c.user && c.user.unique_id) || "",
  nickname: (c.user && c.user.nickname) || "",
});

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), value });
}

// -> { ok:true, comments:[{cid,text,username,nickname}], via } | { ok:false, error, limited }
async function fetchComments(videoUrl) {
  const hit = cache.get(videoUrl);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.value;

  const deadline = Date.now() + BUDGET_MS;
  const left = () => deadline - Date.now();
  let body = null, via = "langsung", lastErr = null;

  try { body = await direct(videoUrl, Math.min(DIRECT_MS, left())); }
  catch (e) { lastErr = e; }

  if (!body && left() > 3000) {
    let pool = [];
    try { pool = shuffle(await getPool(Math.min(6000, left()))).slice(0, MAX_TRIES); }
    catch (e) { lastErr = lastErr || e; }

    for (let i = 0; i < pool.length && !body && left() > 2500; i += BATCH) {
      const ac = new AbortController();
      const ms = Math.min(PROXY_MS, left() - 500);
      try {
        const r = await Promise.any(
          pool.slice(i, i + BATCH).map((p) => viaProxy(videoUrl, p, ms, ac.signal).then((b) => ({ b, p })))
        );
        body = r.b;
        via = r.p;
      } catch (agg) {
        const errs = (agg && agg.errors) || [agg];
        lastErr = errs[0] || lastErr;
        if (errs.some((x) => x && x.noCurl)) break; // tanpa curl, proxy tidak bisa dipakai
      } finally {
        ac.abort();
      }
    }
  }

  if (!body) {
    return {
      ok: false,
      limited: isLimit(lastErr),
      error: isLimit(lastErr)
        ? "Pengecekan komentar sedang padat (kuota habis), coba lagi beberapa saat lagi"
        : "Tidak bisa mengecek komentar saat ini, coba lagi sebentar lagi",
    };
  }

  const raw = (body.data && body.data.comments) || [];
  const value = { ok: true, comments: raw.map(simplify).filter((c) => c.username), via };
  remember(videoUrl, value);
  return value;
}

// Cocokkan username (tanpa @, tidak peka huruf besar/kecil). Kalau yang diketik ternyata nickname, dikembalikan di `nick`.
function findCommenter(comments, name) {
  const n = norm(name);
  const hit = comments.find((c) => norm(c.username) === n) || null;
  const nick = hit ? null : comments.find((c) => String(c.nickname || "").trim().toLowerCase() === n) || null;
  return { hit, nick };
}

// Daftar nama unik (urutan sesuai kemunculan) untuk panel di browser.
function commenters(comments) {
  const seen = new Set();
  const out = [];
  for (const c of comments) {
    const k = norm(c.username);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ username: c.username, nickname: c.nickname });
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

module.exports = { fetchComments, findCommenter, commenters, norm };
