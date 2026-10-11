const ALLOWED = new Set(["favorites", "comments-hearts", "checkid"]);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const fail = (code, massage) => res.status(code).json({ status: "error", massage });

  if (req.method !== "GET") return fail(405, "Method tidak diizinkan");

  const base = (process.env.NGROK_URL || process.env.ngrok_url || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return fail(500, "Server belum dikonfigurasi (NGROK_URL kosong)");

  const { p, ...params } = req.query;
  if (!ALLOWED.has(p)) return fail(404, "Layanan tidak ditemukan");

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(Array.isArray(v) ? v[0] : v).slice(0, 500));
  }

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
      return fail(502, "Server utama tidak merespons dengan benar. Pastikan server dan ngrok sedang menyala.");
    }
    return res.status(upstream.status).json(data);
  } catch {
    // Pesan sengaja generik supaya URL ngrok tidak bocor lewat error
    return fail(504, "Tidak bisa terhubung ke server utama. Pastikan server dan ngrok sedang menyala.");
  }
};
