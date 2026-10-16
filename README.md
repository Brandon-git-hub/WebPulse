# WebPulse

WebPulse is an 8-channel logic analyzer for Cypress FX2 boards such as the WeAct
LogicAnalyzerV1 / CBM9002A running sigrok's fx2lafw firmware. It is meant as a
lighter alternative to PulseView: a small C daemon does the capture and serves a
browser UI that draws the waveforms on a canvas.

```
FX2 board ──USB──▶ webpulse (C: libusb + CivetWeb) ──HTTP/WebSocket──▶ browser
```

- Fixed-length capture up to 24 MHz, with a software trigger (level and edge
  conditions per channel) and an adjustable pre-trigger share.
- The browser asks only for the part it is showing. Each reply is about 2 bytes
  per pixel, however long the capture, and a 256M-sample capture answers in
  under 1 ms.
- One executable with the UI built in. The Windows build needs no extra DLLs.
- A simulator backend, so all of it can be developed and tested without
  hardware.

## Build

Linux (development, tests, simulator only unless libusb-1.0 is installed):

```bash
cmake -S . -B build/linux -G Ninja
cmake --build build/linux
ctest --test-dir build/linux
```

Windows (cross-compiled from Linux with llvm-mingw, toolchain under `/mnt/ssd/tools`):

```bash
cmake -S . -B build/win -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-w64-x86_64.cmake
cmake --build build/win
# -> build/win/webpulse.exe + build/win/firmware/
```

Copy `webpulse.exe` together with the `firmware/` folder next to it.

## Run

```bash
webpulse                         # fx2 backend, UI on http://127.0.0.1:8080/
webpulse --listen 0.0.0.0        # allow remote browsers (open the firewall port)
webpulse -b sim                  # simulator, no hardware needed
webpulse -b sim -w web           # serve web/ from disk while editing the UI
```

One-shot capture without the UI:

```bash
webpulse -c -r 24M -n 10M -t XXXXXXXR --pre 10 -o capture.vcd
```

The trigger is 8 characters, one per channel, with character *i* applying to
CH*i*: `X` don't care, `0`/`1` level, `R` rising, `F` falling, `E` either edge.
All conditions must be true at once (AND). `--channels 0-3,6` limits the output
file to those channels. Run `webpulse --help` for every option.

In the UI, the **Channels** button opens a picker like PulseView's: tick channels
one by one, or enable / disable *All*, *Changing*, *Non-changing* (whether the
channel toggles in the current capture), *Named* or *Unnamed* (renamed from the
default `CHn` or not). Hidden channels are ignored by the trigger and left out
of VCD/CSV exports; all 8 are still captured. Mouse wheel zooms, dragging pans, a click places cursor A and
Shift+click places cursor B. Keys: `F` fit, `T` jump to the trigger, `R` run,
`S` stop, `Esc` clear the cursors.

Behind code-server, run the daemon in the container and open
`https://<code-server>/proxy/8080/`. The UI uses only relative URLs, so it
works under that path prefix.

## Windows setup (first time)

1. Plug in the board and open Device Manager. It shows up as `VID_0925&PID_3881`
   if its EEPROM is programmed, or `VID_04B4&PID_8613` if the EEPROM is blank.
2. With [Zadig](https://zadig.akeo.ie/), install **WinUSB** for that device. When
   WebPulse uploads the firmware, the board reconnects as `0925:3881`. If Zadig
   then shows that ID without WinUSB, install WinUSB for it as well.
3. Run `webpulse.exe`, then open http://127.0.0.1:8080/.

When WebPulse opens the board (at start-up, or on the next Run if the board was
plugged in later), it uploads `firmware/fx2lafw-saleae-logic.fw` to the board's
RAM, which takes about 1–2 s.

## HTTP / WebSocket API

| Method | Path | |
|---|---|---|
| GET | `/api/device` | backend, model, firmware, supported rates, max samples |
| POST | `/api/capture` | `{"rate":24000000,"samples":10000000,"pre":0.1,"trigger":"XXXXXXXR","timeout_ms":0}` |
| POST | `/api/stop` | stop; samples captured after the trigger are kept |
| GET | `/api/status` | `idle / armed / capturing / processing / done / error`, progress; `capture.changing` = mask of channels that toggle |
| GET | `/api/export?fmt=vcd\|csv[&names=a,b,…][&channels=0-3,6][&changes=0]` | download the capture (`channels`: which channels to include, default all) |

WebSocket `/ws`. The server pushes `{"type":"status",…}` whenever the state
changes. The client sends `{"type":"query","id":1,"t0":0,"t1":1000000,"width":1200}`
and gets back a binary reply (little-endian):

```
u32 id | u8 mode | u8 0 | u16 width | u64 t0 | u64 t1 | payload
mode 0: raw samples t0..t1 (1 byte per sample, bit c = CH c)
mode 1: u16 per pixel, bit 2c = CH c was high, bit 2c+1 = CH c was low
```

## Tests

- `ctest` runs the C unit tests: trigger, mipmap store, fx2 protocol
  encoding, JSON, the capture engine with the simulator, and VCD/CSV export.
- `tests/web_smoke.mjs` runs the real `web/js/app.js` under Node 22+ with a
  fake DOM against a live server, and drives it like a user would:

  ```bash
  ./build/linux/webpulse -b sim -p 18080 &
  node tests/web_smoke.mjs http://127.0.0.1:18080/
  ```

## Layout

```
src/        daemon (C11): capture engine, trigger, store, backends, server
web/        UI (plain ES modules, no build step), embedded at build time
tests/      unit tests and the web smoke test
tools/      embed_web.py (web/ -> web_assets.c)
cmake/      Windows cross toolchain
firmware/   fx2lafw-saleae-logic.fw (GPLv2+, loaded at runtime)
third_party/civetweb/   CivetWeb 1.16 (MIT)
```

## Licenses

The WebPulse code uses CivetWeb (MIT). The fx2lafw firmware is GPLv2+ and is
shipped as a separate file with its own `COPYING`; it is not compiled into the
executable.
