// Deteksi otomatis "service padat / lambat" per layanan.
// Data disimpan di memori instance serverless (jendela 60 detik). Kalau Vercel menjalankan banyak instance,
// angka per instance bisa lebih kecil dari total asli; sinyal latensi & error tetap bekerja.
"use strict";

const WINDOW_MS = 60 * 1000;
const BUSY_HITS = 8;       // >= 8 request masuk dalam 60 detik  -> padat
const BUSY_INFLIGHT = 4;   // >= 4 request sedang diproses bersamaan -> padat
const SLOW_AVG_MS = 8000;  // rata-rata respons server utama >= 8 detik -> lambat
const SLOW_FAILS = 2;      // >= 2 gagal/timeout dalam 60 detik -> lambat

const TRACKED = ["favorites", "comments-hearts"];
const stats = {};
for (const s of TRACKED) stats[s] = { hits: [], lat: [], fails: [], inflight: 0 };

const prune = (arr, now, pick) => {
  while (arr.length && now - pick(arr[0]) > WINDOW_MS) arr.shift();
};

function begin(service) {
  const st = stats[service];
  if (!st) return () => {};
  const t0 = Date.now();
  st.hits.push(t0);
  st.inflight++;
  let done = false;
  return (ok) => {
    if (done) return;
    done = true;
    st.inflight = Math.max(0, st.inflight - 1);
    const now = Date.now();
    st.lat.push({ t: now, ms: now - t0 });
    if (!ok) st.fails.push(now);
  };
}

function levelOf(service) {
  const st = stats[service];
  const now = Date.now();
  prune(st.hits, now, (x) => x);
  prune(st.lat, now, (x) => x.t);
  prune(st.fails, now, (x) => x);
  const avgMs = st.lat.length >= 2 ? Math.round(st.lat.reduce((a, b) => a + b.ms, 0) / st.lat.length) : 0;
  let level = "ok";
  let note = "";
  if (st.fails.length >= SLOW_FAILS || avgMs >= SLOW_AVG_MS) {
    level = "slow";
    note = "Service lambat — server sedang lambat merespons. Proses bisa tertunda.";
  } else if (st.hits.length >= BUSY_HITS || st.inflight >= BUSY_INFLIGHT) {
    level = "busy";
    note = "Service padat — banyak permintaan sedang masuk. Proses bisa lebih lama dari biasanya.";
  }
  return { level, note, hits: st.hits.length, inflight: st.inflight, avgMs, fails: st.fails.length };
}

function snapshot() {
  const services = {};
  for (const s of TRACKED) services[s] = levelOf(s);
  return { services };
}

module.exports = { begin, snapshot, TRACKED };
