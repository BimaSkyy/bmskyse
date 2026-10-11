// Proxy server-side: browser -> /api/proxy -> ngrok (URL dibaca dari env, tidak pernah dikirim ke browser)
// Environment Variable di Vercel: NGROK_URL = https://xxxx.ngrok-free.dev
//
// Rute lokal (tidak diteruskan ke ngrok):
//   ?p=validate&url=...  -> cek link video TikTok asli + konversi ke URL web
//   ?p=status            -> status padat/lambat tiap layanan (deteksi otomatis)
// Untuk favorites & comments-hearts, link SELALU divalidasi & dikonversi di server sebelum diteruskan.

const { resolveVideo } = require("../lib/tiktok");
const load = require("../lib/load");

const ALLOWED = new Set(["favorites", "comments-hearts", "checkid"]);
const NEED_VIDEO = new Set(["favorites", "comments-hearts"]);

// Batas cek link per IP (best effort, memori per instance)
const VALIDATE_LIMIT = 20;
const validateHits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const arr = (validateHits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  validateHits.set(ip, arr);
  if (validateHits.size > 2000) validateHits.delete(validateHits.keys().next().value);
  return arr.length > VALIDATE_LIMIT;
}

const first = (v) => String(Array.isArray(v) ? v[0] : v ?? "");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const fail = (code, massage, extra = {}) => res.status(code).json({ status: "error", massage, ...extra });

  if (req.method !== "GET") return fail(405, "Method tidak diizinkan");

  const { p, ...params } = req.query;

  // ---- rute lokal ----
  if (p === "status") return res.status(200).json({ status: "success", ...load.snapshot() });

  if (p === "validate") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.headers["x-real-ip"] || "unknown";
    if (tooMany(ip)) return fail(429, "Terlalu banyak pengecekan link, coba lagi sebentar lagi");
    const v = await resolveVideo(first(params.url));
    if (!v.ok) return fail(422, v.error, { field: "url" });
    return res.status(200).json({ status: "success", url: v.url, id: v.id, user: v.user, title: v.title, verified: v.verified, changed: v.changed });
  }

  // ---- diteruskan ke server utama ----
  const base = (process.env.NGROK_URL || process.env.ngrok_url || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return fail(500, "Server belum dikonfigurasi (NGROK_URL kosong)");

  if (!ALLOWED.has(p)) return fail(404, "Layanan tidak ditemukan");

  let video = null;
  if (NEED_VIDEO.has(p)) {
    video = await resolveVideo(first(params.url));
    if (!video.ok) return fail(422, video.error, { field: "url" });
    params.url = video.url; // pakai URL versi web hasil konversi
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(Array.isArray(v) ? v[0] : v).slice(0, 500));
  }

  const done = load.begin(p);
  try {
    const upstream = await fetch(`${base}/service/${p}?${qs}`, {
      headers: { "ngrok-skip-browser-warning": "1", Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      done(false);
      return fail(502, "Server utama tidak merespons dengan benar. Pastikan server dan ngrok sedang menyala.");
    }
    done(upstream.status < 500);
    if (video && data && typeof data === "object" && !Array.isArray(data)) data["url-web"] = video.url;
    return res.status(upstream.status).json(data);
  } catch {
    done(false);
    // Pesan sengaja generik supaya URL ngrok tidak bocor lewat error
    return fail(504, "Tidak bisa terhubung ke server utama. Pastikan server dan ngrok sedang menyala.");
  }
};
