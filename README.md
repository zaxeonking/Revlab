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
│       ├── gauge.js            Tachometer SVG — reconfigure() untuk rescale (VEHICLE SETUP)
│       ├── speed-gauge.js      Speedometer SVG — reconfigure() untuk rescale (VEHICLE SETUP)
│       ├── rpm-simulator.js    Simulasi RPM fisik nyata — configure() (VEHICLE SETUP)
│       ├── gearbox.js          Matematika drivetrain murni — configure() (VEHICLE SETUP)
│       ├── engine-state.js     Telemetri turunan dari RPM + applyVehicleSetup() (orkestrator)
│       ├── vehicle-setup.js    Data + validasi 12 parameter panel VEHICLE SETUP
│       ├── throttle-controller.js  Input press/hold — configure() (VEHICLE SETUP)
│       ├── audio-engine.js     STUB — kerangka API, belum ada Web Audio API
│       └── ui-controller.js    Wiring DOM ⇄ EngineState + form modal VEHICLE SETUP
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
| **Gearbox / drivetrain math**      | ✅ **gear ratio × final drive × keliling roda × efisiensi — lihat di bawah** |
| **Kontrol gear (keyboard)**        | ✅ **Shift = up, Ctrl = down — otomatis pindah ke MANUAL** |
| **VEHICLE SETUP (12 parameter)**   | ✅ **memengaruhi simulasi langsung, validasi min/max, RESET SETUP — lihat di bawah** |
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

## Tarikan per gigi & shift dip (`rpm-simulator.js`)

Dua perubahan fisika supaya perpindahan gigi terasa nyata, bukan cuma
label angka yang berubah di atas kurva RPM yang identik:

- **Tarikan berbeda per gigi** — laju kenaikan RPM (`ACCEL_RATE_RPM_PER_S`)
  sekarang dikalikan `GEAR_ACCEL_MULT[gearIndex]`. Gigi rendah (1, 2)
  punya multiplier lebih besar (torsi lebih besar → tarikan lebih berat
  dan cepat), gigi tinggi (5, 6) multipliernya lebih kecil (tarikan lebih
  "panjang"/landai, khas top gear). Contoh terukur: dari idle ke
  3500rpm di gigi 1 butuh ~0.5 detik, di gigi 5 butuh ~1 detik — dua
  kali lebih lambat, dengan throttle & fisika dasar yang sama persis.
- **RPM dip saat shift** (`triggerShiftDip`) — begitu gearbox benar-benar
  berpindah gigi (auto ATAU manual, dipanggil dari `stepGear`/`shiftUp`/
  `shiftDown` di `engine-state.js`), RPM berhenti mengejar target
  throttle selama ±220ms dan malah "jatuh" dulu ke sekitar 68% dari RPM
  sebelum shift (`SHIFT_DIP_FRACTION`), meniru kopling terlepas sesaat
  dari mesin. Setelah dip selesai, RPM lanjut mengejar target throttle
  seperti biasa dari titik itu. Efek ini yang membuat shift kerasa
  sebagai satu kejadian (jeda + RPM turun sesaat), bukan cuma nomor
  gigi yang diam-diam berganti di atas RPM yang mulus. Indikator gear di
  gauge (`data-shifting="true"`) sekarang menyala persis selama dip ini
  berlangsung, bukan sekadar mengikuti timer shift-lock kosong.
- Manual shift memicu dip yang sama seperti auto — sengaja begitu,
  karena kopling/synchro tetap ada fisiknya walau perpindahan gigi
  dipicu manual oleh tombol SHIFT, bukan otomatis oleh RPM.

## Gearbox / drivetrain (`gearbox.js`)

RPM dan speed sekarang **benar-benar saling terhubung lewat gear ratio**,
bukan tabel "gigi X mentok di Y km/h" seperti sebelumnya. Formulanya:

```
wheelRPM = engineRPM / (gearRatio × finalDrive)
speedKmh = wheelRPM × wheelCircumferenceM × 0.06 × drivetrainEfficiency
```

(`0.06` = konversi menit→jam dan meter→km sekaligus.)

Parameter yang dipakai (`js/modules/gearbox.js`, satu-satunya sumber
angka ini — dipakai langsung oleh `engine-state.js`, dan ditampilkan
apa adanya di panel POWERTRAIN, bukan diketik ulang di HTML):

- **Gear ratios** (1→6): `3.850 / 2.615 / 1.929 / 1.529 / 1.276 / 1.061`
- **Final drive**: `3.90 : 1`
- **Wheel circumference**: `1.98 m` (kira-kira ban 205/55R16)
- **Drivetrain efficiency**: `92%` (rugi mekanis tetap, bukan slip acak)

Karena speed dihitung langsung dari RPM lewat rasio gigi yang sedang
aktif, RPM yang sama di gigi berbeda menghasilkan speed yang berbeda
secara mekanis nyata — gigi 1 tidak akan pernah mencapai speed gigi 6
walau RPM sama-sama di redline, dan sebaliknya `Gearbox.rpmForSpeed()`
adalah kebalikan pasti dari `Gearbox.speedForRpm()` (bukan aproksimasi).
**Neutral (N) tidak punya rasio sama sekali** — bukan "rasio 0", tapi
memang tidak ada jalur mekanis mesin↔roda, makanya speed tetap 0 keras
di N terlepas dari RPM (lihat juga bagian Perpindahan gigi di bawah).

Speed tetap 100% deterministik — tidak ada `Math.random()` di mana pun
dalam rantai RPM → speed ini, sama seperti simulasi RPM itu sendiri.

## Kontrol gearbox

- **Tombol UI** (desktop): SHIFT ▲ / SHIFT ▼ di panel TELEMETRY.
- **Keyboard**: `Shift` untuk shift up, `Ctrl` untuk shift down. Menekan
  salah satu otomatis memindahkan mode ke MANUAL dulu (kalau masih di
  AUTO) sebelum shift-nya dieksekusi — sama seperti paddle-shift di game
  racing yang langsung mengambil alih kontrol manual begitu dipakai.
- **Mobile**: shifter mengambang di kiri pedal gas (tombol mode
  AUTO/MANUAL, ▲/▼, dan label gigi saat ini) — muncul otomatis di
  viewport ≤640px, mirror 1:1 dari kontrol desktop (guard shift-lock
  yang sama, disabled state yang sama).

Semua jalur kontrol ini (tombol, keyboard, mobile) memanggil fungsi
`EngineState.shiftUp()` / `shiftDown()` yang sama persis — jadi shift-lock,
rev-limiter-per-gigi, dan RPM dip saat shift berlaku sama rata, tidak
peduli dari input mana shift-nya berasal.

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

## PERFORMANCE MODE (`performance-mode.js`)

Panel baru — tombol **PERFORMANCE MODE** (di bawah VEHICLE SETUP) membuka
modal berisi 7 readout (SPEED, RPM, TORQUE, POWER, BOOST, THROTTLE, GEAR)
dan 4 grafik realtime:

- **Speed over time** / **RPM over time** — grafik garis waktu-berjalan
  (rolling window 15 detik), digambar dari buffer yang diisi tiap frame
  `EngineState.subscribe()` selama panel terbuka.
- **Torque curve** / **Power curve** — kurva referensi full-throttle
  (idle→max RPM) dari `EngineState.getTorqueCurve()`, dengan titik penanda
  di posisi RPM/torque/power AKTUAL saat itu (bisa di bawah kurva kalau
  throttle tidak penuh).

Semua angka berasal dari `EngineState` — modul ini tidak memiliki logika
simulasi sendiri, hanya buffer riwayat + rendering `<canvas>` 2D murni
(tanpa library chart).

### Torque & Power

Sebelumnya VEHICLE SETUP punya field Torque/Engine Power tapi keduanya
cuma memengaruhi laju akselerasi RPM — tidak ada angka output Nm/HP
sungguhan. Sekarang `engine-state.js` punya kurva torsi berbentuk
naik→puncak→turun-landai (puncak di ~42% rentang idle→max RPM), diskalakan
oleh Torque VEHICLE SETUP dan posisi throttle saat ini. Power (HP/kW)
diturunkan langsung dari Torque × RPM (bukan input terpisah), sama seperti
hubungan mesin sungguhan.

### Kontrol simulasi: START / PAUSE / RESET

Tiga tombol di footer panel mengontrol simulasi yang SAMA dengan tombol
START ENGINE di kokpit utama (bukan simulasi paralel terpisah):

- **START** — menyalakan mesin (jika mati) atau melanjutkan (jika sedang
  PAUSE).
- **PAUSE** — `RPMSimulator.pause()` membekukan seluruh loop fisika di
  tempat: setiap gauge, readout, dan grafik di seluruh REVLAB berhenti
  bergerak bersamaan, bukan cuma panel ini.
- **RESET** — `RPMSimulator.reset()` + reset gearbox/speed internal
  `EngineState` ke kondisi bersih (mesin mati, RPM 0, gigi N, speed 0),
  dan mengosongkan buffer riwayat grafik.

## Tahap berikutnya (belum dikerjakan)

- Implementasi `AudioEngine` dengan `AudioContext`, sample/oscillator
  suara mesin, dan mapping RPM real-time → pitch/gain.
- Sambungkan suara ke rev limiter (mis. suara "sputter" saat fuel cut).
- Model termal yang lebih realistis di `engine-state.js` (gear ratio /
  drivetrain sudah realistis — lihat `gearbox.js`).

## VEHICLE SETUP (`vehicle-setup.js`)

Panel baru — tombol **VEHICLE SETUP** di bawah spec POWERTRAIN membuka
modal berisi 12 parameter kendaraan yang bisa diubah, dengan validasi
min/max dan tombol **RESET SETUP**. Semua field digenerate dari spec di
`js/modules/vehicle-setup.js` (bukan diketik manual di `index.html`), dan
setiap perubahan langsung diterapkan ke simulasi — tidak ada tombol
"Apply" terpisah.

### Parameter dan efeknya ke simulasi

| Parameter | Range | Efek ke simulasi |
|---|---|---|
| **Weight** | 700–3000 kg | Menurunkan/menaikkan laju akselerasi RPM (lebih berat → tarikan lebih lambat) |
| **Engine Power** | 60–1200 HP | Menaikkan laju akselerasi RPM |
| **Torque** | 60–1400 Nm | Menaikkan laju akselerasi RPM |
| **Idle RPM** | 500–1500 | RPM yang dituju mesin saat throttle 0% (mesin idle) |
| **Redline RPM** | 4000–11000 | Awal zona redline di gauge + memengaruhi titik pindah gigi AUTO |
| **Max RPM** | 4500–12000 | Batas fuel-cut absolut + skala ujung gauge RPM |
| **Gear Ratios (1→6)** | 0.700–5.500 masing-masing | Hubungan RPM↔speed per gigi (`Gearbox.speedForRpm`) |
| **Final Drive** | 2.000–6.000 | Hubungan RPM↔speed di semua gigi |
| **Wheel Radius** | 22–40 cm | Keliling roda → hubungan RPM↔speed di semua gigi |
| **Throttle Response** | 0–100% | Kecepatan ramp pedal gas dari 0→100% (`ThrottleController`) |
| **Engine Braking** | 0–100% | Kecepatan RPM turun saat throttle dilepas / mesin dimatikan |
| **Top Speed** | 80–400 km/h | Governor kecepatan (hard cap) + skala dial speedometer |

Pada nilai default, kalkulasi di atas menghasilkan angka yang **identik**
dengan konstanta hasil tuning manual sebelumnya (idle 800, redline 7500,
max 9000, rasio gigi 3.850/2.615/1.929/1.529/1.276/1.061, final drive
3.900, radius roda 31.5cm ≈ keliling 1.98m, dst) — jadi menambahkan panel
ini tidak mengubah perilaku default simulasi, hanya membuatnya bisa
diubah.

### Validasi

Setiap field divalidasi terhadap min/max saat `change` (blur/Enter):
nilai di luar rentang dibatasi (clamped) ke batas terdekat dan field
langsung menampilkan nilai yang sebenarnya diterapkan, plus pesan
singkat di bawah field. Idle RPM, Redline RPM, dan Max RPM juga
divalidasi silang — sistem otomatis menjaga jarak minimum
(`Idle < Redline < Max`) dengan menggeser field lain jika perlu, supaya
tabel gigi turunannya tidak pernah kehilangan rentang RPM yang valid.

### Reset Setup

Tombol **RESET SETUP** mengembalikan seluruh 12 parameter (termasuk 6
rasio gigi) ke default pabrik dan langsung menerapkannya ke simulasi.

### Alur data

```
VehicleSetup (data + validasi)
        │  VehicleSetup.set()/setGearRatio()/reset()
        ▼
EngineState.applyVehicleSetup(setup)   ← satu titik orkestrasi
        │
        ├─→ RPMSimulator.configure()       (idle/redline/max RPM, accel/decel/spindown rate, rev-limit per gigi)
        ├─→ Gearbox.configure()            (gear ratios, final drive, keliling roda)
        ├─→ ThrottleController.configure() (ramp rate pedal gas)
        └─→ state.maxRpmK / redlineStartK / maxSpeedKmh (dial gauge)
```

`ui-controller.js` membaca field-field itu setiap frame dan memanggil
`Gauge.reconfigure()` / `SpeedGauge.reconfigure()` hanya ketika nilainya
benar-benar berubah (bukan tiap frame), supaya rescale dial tidak
membangun ulang SVG tanpa perlu.
