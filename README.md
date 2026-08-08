# REVLAB — Racing Engine Sound Simulator

Tahap 2: cockpit dashboard interaktif dengan telemetri berbasis
JavaScript state (RPM, gear, throttle, speed, temp, boost, status
mesin). **Belum ada audio.** Semua angka dihitung secara deterministik
dari input throttle / tombol start-stop — tidak ada `Math.random()` dan
tidak ada timer yang mengubah nilai sendiri. Struktur state (`EngineState`)
sudah disiapkan agar simulator mesin sungguhan tinggal memanggil satu
fungsi (`applyFrame`) per tick tanpa mengubah layer UI.

## Cara menjalankan

Project ini adalah HTML/CSS/JS murni — tidak butuh build step atau
package manager.

**Opsi paling sederhana:** buka `index.html` langsung di browser.

**Opsi disarankan** (agar path module lebih konsisten di semua browser),
jalankan local server dari folder ini, misalnya:

```bash
# Python
python3 -m http.server 8000

# atau Node
npx serve .
```

Lalu buka `http://localhost:8000`.

## Struktur project

```
revlab/
├── index.html                  Struktur halaman & markup dashboard
├── css/
│   ├── variables.css           Design tokens (warna, tipografi, spacing)
│   ├── base.css                Reset & default elemen
│   ├── layout.css               Grid/struktur dashboard cockpit
│   ├── components.css          Panel, gauge, tombol, chip status, log
│   └── responsive.css          Breakpoint tablet & mobile
├── js/
│   ├── main.js                 Entry point, inisialisasi modul saat load
│   └── modules/
│       ├── gauge.js            Render tachometer SVG (ticks, redline, jarum)
│       ├── rpm-simulator.js    Simulasi RPM fisik nyata (rAF loop, inersia, rev limiter)
│       ├── engine-state.js     Telemetri turunan dari RPM (gear/speed/temp/boost) + pub/sub
│       ├── audio-engine.js     STUB — kerangka API, belum ada Web Audio API
│       └── ui-controller.js    Wiring DOM ⇄ EngineState (render tiap frame + event)
└── README.md
```

## Status fitur (jujur, sesuai kode saat ini)

| Bagian                            | Status                                          |
|------------------------------------|--------------------------------------------------|
| Layout cockpit responsif           | ✅ selesai (desktop → tablet → mobile)           |
| Gauge RPM (SVG, ticks, redline)    | ✅ jarum digerakkan simulasi RPM tiap frame       |
| Digital RPM value                  | ✅ dari `RPMSimulator`, bukan snapshot            |
| Redline indicator (lampu warning)  | ✅ aktif saat RPM ≥ redline                      |
| Gear indicator                     | ✅ dihitung deterministik dari RPM               |
| Throttle percentage                | ✅ slider aktif saat mesin hidup                 |
| Engine temperature                 | ✅ deterministik, mengikuti RPM                  |
| Speed                              | ✅ deterministik, mengikuti RPM                  |
| Boost / pressure                   | ✅ deterministik, mengikuti throttle             |
| Engine status (chip)               | ✅ off / idle / running / rev limiter            |
| Start / Stop engine button         | ✅ toggle start/stop simulasi RPM                |
| **Simulasi RPM nyata**             | ✅ **rAF loop, inersia, rev limiter — lihat di bawah** |
| Audio engine (Web Audio API)       | 🔲 belum diimplementasikan — hanya stub          |

## Simulasi RPM (`rpm-simulator.js`)

RPM sekarang berasal dari simulasi fisik nyata, bukan rumus snapshot.
Loop berjalan dengan `requestAnimationFrame`, memakai waktu nyata antar
frame (`dt`), dan **tidak memakai `Math.random()` sama sekali**:

- **Throttle 0–100%** menentukan target RPM antara idle dan max.
- **Idle RPM**: `800`. **Maximum RPM**: `9000`. **Redline** (zona visual
  amber pada gauge): `7500`.
- **RPM naik saat throttle ditekan**, mengejar target dengan laju
  terbatas (`ACCEL_RATE_RPM_PER_S`) — inilah bentuk *engine inertia*:
  RPM tidak bisa melompat instan ke nilai baru.
- **RPM turun saat throttle dilepas**, mengejar idle dengan laju
  terbatas berbeda (`DECEL_RATE_RPM_PER_S`, mensimulasikan engine
  braking).
- **Rev limiter**: begitu RPM mencapai `REV_LIMIT_RPM` (8800), fuel
  seolah "dipotong" (throttle efektif dipaksa 0) hingga RPM turun
  melewati batas hysteresis (8350), lalu tenaga kembali menyala. Ditahan
  di throttle penuh, ini menghasilkan efek pantulan rev-limiter yang
  khas — murni dari fisika loop, bukan angka acak.
- Saat mesin dimatikan, RPM **tidak langsung nol** — ia meluncur turun
  (`SPINDOWN_RATE_RPM_PER_S`) seperti mesin sungguhan yang kehilangan
  pengapian.

`engine-state.js` tidak lagi menghitung RPM sendiri — ia hanya membaca
snapshot dari `RPMSimulator` setiap frame dan menurunkan gear/speed/
temp/boost dari situ dengan rumus tetap (deterministik).

`js/modules/audio-engine.js` tetap berisi kerangka API (`init`, `start`,
`stop`, `setThrottle`, `getState`) yang seluruhnya no-op dengan log
konsol — kontrak fungsi untuk implementasi Web Audio API di tahap
berikutnya, belum tersambung ke tombol START/STOP di UI.

## Desain

- **Palet**: dasar hitam/abu gelap (`--bg-0` `#0a0b0d` → `--bg-2` `#1b1d22`),
  dua accent: amber `--accent-amber` `#ff7a1a` (peringatan/redline) dan
  cyan `--accent-cyan` `#29e0e8` (data telemetri digital).
- **Tipografi**: `Rajdhani` untuk display/label teknis, `JetBrains Mono`
  untuk semua angka telemetri (RPM, throttle, dll).
- **Elemen signature**: tachometer radial di tengah dashboard sebagai
  hero instrument, digambar dengan SVG murni (bukan gambar statis) agar
  siap dianimasikan saat data RPM sungguhan tersedia.

## Menghubungkan simulator engine sungguhan

Dua titik ekstensi tersedia, tergantung seberapa dalam simulator baru:

**1. Ganti model fisika RPM saja** (paling umum) — edit konstanta atau
fungsi `step()` di `js/modules/rpm-simulator.js` (mis. kurva torsi
non-linear per gigi, engine braking yang beda per gigi, dll). API publik
(`start`, `stop`, `setThrottle`, `subscribe`, `getState`) tidak perlu
berubah, jadi `engine-state.js` dan UI otomatis ikut.

**2. Ganti seluruh sumber data** (mis. RPM datang dari simulator native
via WebSocket) — cukup panggil method internal `RPMSimulator` yang
sudah ada per frame, atau ekspos ulang `notify()` dengan data dari
sumber eksternal. Karena `engine-state.js` hanya `subscribe()` ke
`RPMSimulator` dan menurunkan telemetri lain secara murni fungsional,
tidak ada file UI yang perlu disentuh.

## Tahap berikutnya (belum dikerjakan)

- Implementasi `AudioEngine` dengan `AudioContext`, sample/oscillator
  suara mesin, dan mapping RPM real-time → pitch/gain.
- Sambungkan suara ke rev limiter (mis. suara "sputter" saat fuel cut).
- Model termal & gear ratio yang lebih realistis di `engine-state.js`.
