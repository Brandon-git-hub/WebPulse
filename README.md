# WebPulse

English · [繁體中文](README.zh-TW.md)

![WebPulse with UART and SPI decoded, cursors on an SPI burst and the PWM line measured](docs/images/overview-dark.png)

WebPulse is an 8-channel logic analyzer for Cypress FX2 boards such as the WeAct
LogicAnalyzerV1 / CBM9002A running sigrok's fx2lafw firmware. It is meant as a
lighter alternative to PulseView: a small C daemon does the capture and serves a
browser UI that draws the waveforms on a canvas.

```
FX2 board ──USB──▶ webpulse (C: libusb + CivetWeb) ──HTTP/WebSocket──▶ browser
```

- Fixed-length capture up to 24 MHz, with a software trigger (level and edge
  conditions per channel) and an adjustable pre-trigger share.
- Protocol decoders (UART, SPI, I²C, parallel bus, counter) and your own in
  JavaScript.
- Opens and saves sigrok / PulseView session files (`.sr`); exports VCD, CSV
  and PNG.
- The browser asks only for the part it is showing. Each reply is about 2 bytes
  per pixel, however long the capture, and a 256M-sample capture answers in
  under 1 ms.
- One executable with the UI built in. The Windows build needs no extra DLLs.
- A simulator backend, so all of it can be developed and tested without
  hardware.

## Screenshots

From the whole capture to single bytes by double-clicking, then cursors that
snap to edges and the live measurement of the line under the pointer:

![Zooming in by double-click, placing cursors and measuring](docs/images/demo.png)

| Light theme | Decoder settings | Channel picker |
|---|---|---|
| ![Light theme](docs/images/overview-light.png) | ![Decoder settings](docs/images/decoder-editor.png) | ![Channel picker](docs/images/channels.png) |

The images are made from the simulator by `tools/docshots.mjs` (see Tests).

## Download

Prebuilt packages are on the GitHub releases page:

- `webpulse-<version>-win64.zip`: Windows 10/11 x64, one `webpulse.exe` with
  no DLLs to install
- `webpulse-<version>-linux-x86_64.tar.gz`: Linux x86_64, statically linked
  libusb, glibc 2.35 or newer

Unpack and keep the `firmware/` folder next to the executable.

## Build

Linux (development and tests; the FX2 backend is built when pkg-config finds
libusb-1.0, otherwise only the simulator):

```bash
cmake -S . -B build/linux -G Ninja
cmake --build build/linux
ctest --test-dir build/linux
```

A libusb without udev is enough, and also works in a container. To build one
statically:

```bash
./configure --prefix=$HOME/libusb-linux --disable-udev --enable-static --disable-shared CFLAGS="-O2 -fPIC"
make install
export PKG_CONFIG_PATH=$HOME/libusb-linux/lib/pkgconfig
```

If `PKG_CONFIG_PATH` also lists the MinGW sysroot, put the Linux directory
first. Both hold a `libusb-1.0.pc`, and pkg-config uses the first one it finds.

Windows (cross-compiled from Linux with llvm-mingw, toolchain under `/mnt/ssd/tools`):

```bash
cmake -S . -B build/win -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-w64-x86_64.cmake
cmake --build build/win
# -> build/win/webpulse.exe + build/win/firmware/
```

Copy `webpulse.exe` together with the `firmware/` folder next to it.

## Run

```bash
webpulse                         # fx2 backend, UI on http://127.0.0.1:9002/
webpulse --browser               # ...and open it in the default browser
webpulse --listen 0.0.0.0        # allow remote browsers (see "Remote access")
webpulse -b sim                  # simulator, no hardware needed
webpulse -b sim -w web           # serve web/ from disk while editing the UI
```

If port 9002 is taken (some editors and tools listen on it) WebPulse uses the
next free one up to 9011 and prints the address. With `-p PORT` it uses exactly
that port and stops with the reason if it cannot.

One-shot capture without the UI, and converting a file:

```bash
webpulse -c -r 24M -n 10M -t XXXXXXXR --pre 10 -o capture.vcd
webpulse --open capture.sr -o capture.vcd       # .sr -> .vcd / .csv / .sr
webpulse --open capture.sr                       # show a file in the UI
```

The trigger is 8 characters, one per channel, with character *i* applying to
CH*i*: `X` don't care, `0`/`1` level, `R` rising, `F` falling, `E` either edge.
All conditions must be true at once (AND). `--channels 0-3,6` limits the output
file to those channels. Run `webpulse --help` for every option.

In the UI, the **Channels** button opens a picker like PulseView's: tick channels
one by one, or enable / disable *All*, *Changing*, *Non-changing* (whether the
channel toggles in the current capture), *Named* or *Unnamed* (renamed from the
default `CHn` or not). Hidden channels are ignored by the trigger and left out
of VCD/CSV exports; all 8 are still captured.

| Mouse / key | Action |
|---|---|
| left double-click / right double-click | zoom in / out ×2 around the pointer (Ctrl: ×8) |
| left drag | pan |
| Shift+left / Shift+right click | place cursor A / B (hold to drag it); snaps to an edge within 8 px, Alt: no snapping |
| `[` `]` / `{` `}` | move cursor A / B to the previous / next edge of the highlighted channel |
| drag a cursor line | move that cursor |
| wheel | zoom (Shift+wheel pans) |
| `+` `-` · `F` · `Z` · `Backspace` | zoom · fit · zoom to A↔B · previous view |
| `T` · `R` · `S` · `Esc` | go to the trigger · run · stop · clear the cursors |

The toolbar has the same zoom in / out, Fit, A↔B and Back buttons.

The channel row under the pointer is highlighted and measured: the status bar
shows the high and low time, period, frequency and duty cycle of the pulse
under the pointer, and the pulse is marked on the canvas. The Edge ◀ ▶ buttons
in the status bar step cursor A (Shift: B) like `[` / `]`.

Behind code-server, run the daemon in the container and open
`https://<code-server>/proxy/9002/`. The UI uses only relative URLs, so it
works under that path prefix.

## Remote access

By default WebPulse only listens on this computer. With `--listen 0.0.0.0` (or
an address of one of its network interfaces) other computers can connect, and
then need an access token. WebPulse makes a random one at start-up and prints
the address to open:

```
WebPulse 0.2.1 listening on port 9002  (Ctrl+C to quit)
  on this computer:  http://localhost:9002/
  from elsewhere:    http://<this-computer>:9002/?token=930b25a523cc8bb39041ac3f524115ba
```

Opening that address once stores the token in a cookie for that browser, and
the page reloads without it in the address bar. Without the token, a page
asks for it and the API answers 401. Connections from this computer itself
never need it. `--token TOKEN` sets a fixed token (8 to 64 characters, for
example for a bookmark); `--no-auth` turns the check off. The connection is
plain HTTP, so use it on a network you trust, and allow the port through the
firewall.

## Files

**Open** (or dropping a file on the page) loads a sigrok session file, as
saved by PulseView or sigrok-cli; channel names come from the file and the
channels it does not have are hidden. **Save .sr** writes one that PulseView
opens, with the channel names and only the shown channels; the trigger
position is kept for WebPulse. Files with more than 8 channels load their
first 8. Opening a file replaces the current capture.

## Protocol decoders

**Decoders** in the toolbar adds a decoder below the channels: UART, SPI, I²C,
Parallel (a bus value from up to 8 lines, optionally clocked) and Counter
(numbers the edges of a line). Each one has its channel assignment and
options; click its row label to change them. Hover an annotation to see it in
full in the status bar. Decoders run in the browser on the transitions of the
channels they use, so even a 256M-sample capture decodes in about a second.

A new decoder picks its channels by name: a channel named "SCLK" or "SDA"
goes to SPI's CLK or I²C's SDA.

### Writing your own

A decoder is a JavaScript module in the `decoders/` folder next to the
executable (or the folder given with `--decoders DIR`). Press **Reload** in the
Decoders panel after adding or editing one. `decoders/pwm.js` is a short
example, and the built-in decoders in `web/decoders/` are longer ones.

```js
export default {
  id: 'pwm',
  name: 'PWM',
  desc: 'Duty cycle of each period',                  // optional
  channels: [{ id: 'pwm', name: 'PWM' }],              // optional: true for optional lines;
                                                       // auto: true assigns an optional one on Add;
                                                       // aliases: ['sck'] other channel names to match
  options: [{ id: 'active', name: 'Active level', default: 'high', values: ['high', 'low'] }],
  rows: [{ id: 'duty', name: 'Duty' }],                // annotation rows, top to bottom

  *decode(d, o) {                                      // o = the option values
    let start = yield d.wait({ pwm: 'r' });
    for (;;) {
      const mid = yield d.wait({ pwm: 'f' });
      const end = yield d.wait({ pwm: 'r' });
      const duty = (100 * (mid - start)) / (end - start);
      d.put(start, end, 'duty', [`${duty.toFixed(1)} %`, `${Math.round(duty)}`]);
      start = end;
    }
  },
};
```

`decode` is a generator. It asks for the next sample of interest with
`yield d.wait(cond)` and gets that sample number back; when nothing matches
before the end of the capture, decoding stops (code in a `finally` block still
runs, for example to close an annotation that lasts until the end).

| | |
|---|---|
| `{ rx: 'f' }` | a condition per channel: `'r'` rising, `'f'` falling, `'e'` either edge, `'h'` high, `'l'` low; all must hold |
| `[{ clk: 'r' }, { cs: 'e' }]` | one of several; `d.matched[i]` tells which held |
| `{ skip: n }` / `d.until(s)` | n samples later (may be fractional) / at sample s |
| `d.pins.rx` | 0 or 1 at the current sample |
| `d.samplenum`, `d.rate`, `d.n` | current sample, sample rate in Hz, samples in the capture |
| `d.has('cs')` | whether an optional channel is assigned |
| `d.put(start, end, row, texts)` | an annotation; `texts` is a string or an array from longest to shortest, the longest that fits is shown |
| `d.hex(v, bits)`, `d.bin`, `d.dec`, `d.oct`, `d.ascii(v)`, `d.format(v, bits, 'hex')` | text helpers |

Waiting always moves forward: a condition that holds at the current sample
does not count. Errors thrown by a decoder are shown in its row; annotations
made before the error are kept.

## Windows setup (first time)

0. Windows SmartScreen may warn that the app is unrecognised, because
   `webpulse.exe` is not code-signed. Either click **More info → Run anyway**,
   or, before unpacking, right-click the zip → **Properties** → tick
   **Unblock**, so none of the unpacked files are flagged.
1. Plug in the board and open Device Manager. It shows up as `VID_0925&PID_3881`
   if its EEPROM is programmed, or `VID_04B4&PID_8613` if the EEPROM is blank.
2. With [Zadig](https://zadig.akeo.ie/), install **WinUSB** for that device. When
   WebPulse uploads the firmware, the board reconnects as `0925:3881`. If Zadig
   then shows that ID without WinUSB, install WinUSB for it as well.
3. Run `webpulse.exe`, then open the address it prints, normally
   http://127.0.0.1:9002/ (in Windows Terminal, Ctrl+click it). To have the
   browser open by itself, make a shortcut to `webpulse.exe --browser`.

When WebPulse opens the board (at start-up, or on the next Run if the board was
plugged in later), it uploads `firmware/fx2lafw-saleae-logic.fw` to the board's
RAM, which takes about 1–2 s.

## Linux setup (first time)

Give users access to the board with a udev rule, for example
`/etc/udev/rules.d/60-webpulse.rules`:

```
SUBSYSTEM=="usb", ATTR{idVendor}=="0925", ATTR{idProduct}=="3881", MODE="0666"
SUBSYSTEM=="usb", ATTR{idVendor}=="04b4", ATTR{idProduct}=="8613", MODE="0666"
```

Then run `sudo udevadm control --reload && sudo udevadm trigger` and replug the
board.

**In a Docker container**, mount the whole USB tree rather than a single device
node, because the board comes back with a new device number after the
firmware upload:

```
-v /dev/bus/usb:/dev/bus/usb --device-cgroup-rule='c 189:* rmw'
```

The udev rule goes on the host. The container needs no udev: WebPulse polls for
the board after uploading the firmware.

## HTTP / WebSocket API

| Method | Path | |
|---|---|---|
| GET | `/api/device` | backend, model, firmware, supported rates, max samples |
| POST | `/api/capture` | `{"rate":24000000,"samples":10000000,"pre":0.1,"trigger":"XXXXXXXR","timeout_ms":0}` |
| POST | `/api/stop` | stop; samples captured after the trigger are kept |
| GET | `/api/status` | `idle / armed / capturing / processing / done / error`, progress; `capture.changing` = mask of channels that toggle |
| GET | `/api/export?fmt=vcd\|csv\|sr[&names=a,b,…][&channels=0-3,6][&changes=0]` | download the capture (`channels`: which channels to include, default all) |
| POST | `/api/open?name=FILE.sr` | body: a sigrok session file; it becomes the current capture |
| GET | `/api/transitions?mask=M[&from=S]` | binary list of the samples where the channels in mask `M` change (used by the decoders; see `api_transitions` in `src/server.c`) |
| GET | `/api/decoders`, `/api/decoders/NAME.js` | the user decoder files in `--decoders DIR` |

WebSocket `/ws`. The server pushes `{"type":"status",…}` whenever the state
changes. The client sends `{"type":"query","id":1,"t0":0,"t1":1000000,"width":1200}`
and gets back a binary reply (little-endian):

```
u32 id | u8 mode | u8 0 | u16 width | u64 t0 | u64 t1 | payload
mode 0: raw samples t0..t1 (1 byte per sample, bit c = CH c)
mode 1: u16 per pixel, bit 2c = CH c was high, bit 2c+1 = CH c was low
```

`{"type":"edges","id":7,"ch":5,"s":1000}` returns the edges of CH5 around sample
1000 as text: `{"type":"edges","id":7,"ch":5,"s":1000,"level":0,"pm":912,"p":960,"n":1008,"nn":1056}`.
`p` is where the current level started, `n` the next edge, `pm` / `nn` the
edges before / after those (-1 if none). The search skips constant stretches
through the summary pyramid, so it is fast on any capture length.

## Tests

- `ctest` runs the C unit tests: trigger, mipmap store, fx2 protocol
  encoding, JSON, the capture engine with the simulator, VCD/CSV export, and
  ZIP / deflate / `.sr` reading and writing.
- `tests/decoders_test.mjs` checks the decoder runtime and the built-in
  decoders on generated waveforms (run by `ctest` when Node.js is found).
- `tests/browser_check.mjs` drives the UI in headless Chrome (`$CHROME`, or
  `chromium` on PATH) against the simulator: the side list lines up with the
  canvas, decoders run in a Web Worker, no script errors; with a second
  argument it saves screenshots there.
- `tests/web_smoke.mjs` runs the real `web/js/app.js` under Node 22+ with a
  fake DOM against a live server, and drives it like a user would:

  ```bash
  ./build/linux/webpulse -b sim -p 18080 &
  node tests/web_smoke.mjs http://127.0.0.1:18080/
  ```
- `tools/docshots.mjs` takes the README images in headless Chrome:

  ```bash
  ./build/linux/webpulse -b sim -p 18080 -d decoders &
  node tools/docshots.mjs http://127.0.0.1:18080/ docs/images
  ```

## Layout

```
src/        daemon (C11): capture engine, trigger, store, backends, server
web/        UI (plain ES modules, no build step), embedded at build time;
            web/decoders/ built-in protocol decoders, web/js/decode/ their runtime
decoders/   example user decoder, copied next to the executable
tests/      unit tests, decoder tests, the web smoke test and the browser check
tools/      embed_web.py (web/ -> web_assets.c), package.py (release archives),
            docshots.mjs (README images)
docs/images/  README screenshots
cmake/      Windows cross toolchain
firmware/   fx2lafw-saleae-logic.fw (GPLv2+, loaded at runtime)
third_party/civetweb/   CivetWeb 1.16 (MIT)
```

## Licenses

WebPulse is released under the MIT License (see `LICENSE`).

- libusb is LGPL-2.1 and is linked statically into the release executables.
  Its source is at https://github.com/libusb/libusb (the release builds use
  1.0.30). To use a modified libusb, rebuild WebPulse from this source against
  it, as described under Build.

- `third_party/civetweb/`: CivetWeb, MIT (`third_party/civetweb/LICENSE.md`).
- `firmware/`: the fx2lafw firmware is GPLv2+ and is shipped as a separate file
  with its own `COPYING`. It is loaded at run time and not compiled into the
  executable, so it keeps its own license.
