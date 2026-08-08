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
| Gear indicator                     | ✅ state machine dengan hysteresis + shift-lock delay — lihat di bawah |
| Gear mode AUTO / MANUAL            | ✅ toggle mode + tombol SHIFT ▲▼ manual           |
| Throttle percentage                | ✅ slider aktif saat mesin hidup                 |
| Throttle press/hold (keyboard/UI/mobile) | ✅ **W / ↑, tombol UI, pedal mobile — lihat di bawah** |
| Engine temperature                 | ✅ deterministik, mengikuti RPM                  |
| Speed                              | ✅ deterministik, satuan KM/H ⇄ MPH (toggle tampilan) |
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

## Kontrol throttle press/hold (`throttle-controller.js`)

Selain slider (posisi absolut), throttle sekarang punya jalur input
bergaya "pedal" — ditekan untuk naik, dilepas untuk turun:

- **Desktop**: tombol `W`, tombol panah `↑`, atau tombol **THROTTLE**
  di control strip. Ketiganya bisa ditahan.
- **Mobile**: pedal gas melingkar mengambang di kanan-bawah layar
  (muncul otomatis di viewport ≤640px, tombol THROTTLE desktop
  disembunyikan di lebar itu supaya tidak tumpang tindih gestur).
- **Press / hold / release**: setiap sumber input hanya melapor
  "ditekan" atau "tidak" ke satu `Set` sumber aktif di
  `ThrottleController`. Selama set itu tidak kosong, throttle naik
  menuju 100%; begitu kosong (semua sumber dilepas), throttle turun
  menuju 0% — dengan laju berbeda (naik lebih cepat dari turun),
  independen dari inersia RPM di `rpm-simulator.js`. Jadi ada dua
  lapis smoothing: kecepatan "kaki" (ramp throttle) lalu kecepatan
  flywheel (inersia RPM) — sama seperti pedal gas sungguhan yang
  meneruskan gerakan kaki ke RPM secara bertahap, bukan instan.
- **Keyboard vs touch tidak bentrok**: karena semua sumber cuma
  menambah/menghapus id dirinya sendiri dari satu `Set`, menahan `W`
  sambil juga menyentuh pedal mobile (mis. keyboard eksternal di
  tablet) tidak menghasilkan nilai ganda — throttle tetap hanya
  mengejar satu target (100% jika *ada* sumber aktif, 0% jika tidak).
  Pointer Events (`pointerdown`/`pointerup`/`lostpointercapture`)
  dipakai untuk tombol & pedal supaya mouse, touch, dan pen memakai
  jalur kode yang sama tanpa cabang khusus per perangkat.
- **Indikator throttle realtime**: bar di dekat slider (desktop) dan
  meter mini di badan pedal (mobile) di-update setiap frame langsung
  dari `ThrottleController.subscribe()` — independen dari RPM, jadi
  tetap responsif walau engine mati (misalnya untuk melihat pedal
  ditekan sebelum START ENGINE, meski RPM baru bergerak setelah
  mesin hidup).

`js/modules/audio-engine.js` tetap berisi kerangka API (`init`, `start`,
`stop`, `setThrottle`, `getState`) yang seluruhnya no-op dengan log
konsol — kontrak fungsi untuk implementasi Web Audio API di tahap
berikutnya, belum tersambung ke tombol START/STOP di UI.

## Perpindahan gigi (`engine-state.js` — `stepGear`)

Gear tidak lagi murni hasil lookup `gearForRpm(rpm)` seperti tahap
sebelumnya — sekarang jadi state machine kecil di `stepGear()`, karena
lookup polos tidak punya "ingatan": begitu RPM sedikit berosilasi di
sekitar titik pindah gigi (mis. persis 3500rpm), gear akan lompat
bolak-balik setiap frame, terasa "gelitikan"/mentok-mentok.

Dua mekanisme mengatasi itu:

- **Hysteresis** — titik pindah naik (`upAt`) dan titik pindah turun
  (`downAt`) untuk gear yang sama sengaja berbeda dan berjarak cukup
  jauh (mis. gigi 2: naik di 3500rpm, baru turun lagi di 1500rpm).
  Begitu naik gigi, RPM harus turun jauh lebih dalam dulu sebelum
  turun gigi lagi — meniru gearbox sungguhan.
- **Shift-lock delay** (`SHIFT_LOCK_MS` = 260ms) — setiap kali gearbox
  pindah gigi (naik atau turun), ia "terkunci" sebentar dan menolak
  pindah gigi lagi sampai delay itu habis. Ini yang menghasilkan jeda
  terasa (seperti waktu kopling/synchro) alih-alih gear number yang
  berubah instan. Selama jeda ini, indikator gear di gauge berkedip
  redup (`data-shifting="true"`) sebagai umpan balik visual.

**Mode AUTO vs MANUAL** (`EngineState.setGearMode`):

- **AUTO** (default) — `stepGear()` jalan setiap frame simulasi,
  gearbox pindah sendiri berbasis RPM seperti dijelaskan di atas.
- **MANUAL** — `stepGear()` otomatis berhenti dipanggil; gear hanya
  berubah lewat `EngineState.shiftUp()` / `shiftDown()` (tombol SHIFT
  ▲▼ di panel telemetry). Shift-lock yang sama tetap berlaku supaya
  shift manual terasa sama beratnya dengan auto — spam-klik tombol
  SHIFT tidak akan melompat beberapa gigi sekaligus dalam sekejap.
  Jika RPM mentok redline tanpa di-shift naik, rev limiter tetap
  aktif seperti biasa (mesin tidak "menyelamatkan diri" sendiri di
  mode manual).
- Pindah dari AUTO ke MANUAL tidak mengubah gigi saat itu juga — mode
  manual melanjutkan persis dari gigi terakhir yang dipilih AUTO.

## Satuan kecepatan (KM/H ⇄ MPH)

`EngineState` tetap menyimpan `speedKmh` sebagai satu-satunya sumber
data (tidak berubah, supaya `boostBar`/formula lain yang mungkin
bergantung padanya tidak perlu disentuh). Toggle satuan murni ada di
`ui-controller.js`: `speedUnit` adalah preferensi tampilan lokal, dan
`formatSpeed()` mengonversi ke MPH (`km/h ÷ 1.609344`) hanya saat
merender ke DOM. Tombol toggle ada di sebelah readout SPEED di panel
TELEMETRY.



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
