// Proxy server-side: browser -> /api/proxy -> ngrok (URL dibaca dari env, tidak pernah dikirim ke browser)
// Environment Variable di Vercel: NGROK_URL = https://xxxx.ngrok-free.dev
//
// Rute lokal (tidak diteruskan ke ngrok):
//   ?p=validate&url=...  -> cek link video TikTok asli + konversi ke URL web
//   ?p=status            -> status padat/lambat tiap layanan (deteksi otomatis)
// Untuk favorites & comments-hearts, link SELALU divalidasi & dikonversi di server sebelum diteruskan.
// Untuk comments-hearts, komentar milik username juga dicek dulu (lib/comments.js):
//   ada   -> diteruskan ke server utama
//   tidak -> 422 + daftar pengomentar (field "commenters") supaya browser bisa menampilkan panel pilihan

const { resolveVideo } = require("../lib/tiktok");
const { fetchComments, findCommenter, commenters, norm } = require("../lib/comments");
const load = require("../lib/load");

const ALLOWED = new Set(["favorites", "comments-hearts", "checkid"]);
const NEED_VIDEO = new Set(["favorites", "comments-hearts"]);

// Batas per IP (best effort, memori per instance)
function limiter(limit) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 2000) hits.delete(hits.keys().next().value);
    return arr.length > limit;
  };
}
const tooManyValidate = limiter(20);
const tooManyComments = limiter(10);

const first = (v) => String(Array.isArray(v) ? v[0] : v ?? "");
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.headers["x-real-ip"] || "unknown";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const fail = (code, massage, extra = {}) => res.status(code).json({ status: "error", massage, ...extra });

  if (req.method !== "GET") return fail(405, "Method tidak diizinkan");

  const { p, ...params } = req.query;
  const ip = clientIp(req);

  // ---- rute lokal ----
  if (p === "status") return res.status(200).json({ status: "success", ...load.snapshot() });

  if (p === "validate") {
    if (tooManyValidate(ip)) return fail(429, "Terlalu banyak pengecekan link, coba lagi sebentar lagi");
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

  // ---- comments-hearts: pastikan komentar username itu benar-benar ada ----
  if (p === "comments-hearts") {
    const shown = first(params.name_comment).trim().replace(/^@+/, "");
    const name = norm(shown);
    if (!name) return fail(422, "Username wajib diisi", { field: "user" });
    if (tooManyComments(ip)) return fail(429, "Terlalu banyak pengecekan komentar, coba lagi sebentar lagi");

    const c = await fetchComments(video.url);
    if (!c.ok) return fail(503, c.error);

    const { hit, nick } = findCommenter(c.comments, name);
    if (!hit) {
      const list = commenters(c.comments);
      let msg;
      if (!list.length) msg = "Video ini belum punya komentar yang bisa dicek";
      else if (nick) msg = `"${shown}" adalah nickname, bukan username. Username-nya @${nick.username}`;
      else msg = `Komentar dari @${shown} tidak ditemukan di video ini. Pilih nama dari daftar di bawah`;
      return fail(422, msg, { field: "user", commenters: list, total: list.length });
    }
    params.name_comment = hit.username; // pakai penulisan username asli dari TikTok
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
