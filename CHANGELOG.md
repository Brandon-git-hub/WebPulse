# Changelog

## Unreleased

- Decoders are added the way PulseView does it. The **Decoders** button opens a
  list docked on the right: search by name, description or channel; the
  selected decoder's channels and options are described below the list;
  double-click it or press Enter to add it. The list stays open for adding
  more.
- A decoder's settings open in a popup beside its row label (click, or
  right-click): name, colour, channels with their descriptions, and options.
  Each change applies at once, with no Apply button. Esc or a click outside
  closes the popup.

## 0.2.3

- Windows: double-clicking `webpulse.exe` no longer leaves a console window.
  The UI opens in the browser, and WebPulse exits once the last browser tab
  using it has been closed. A second double-click opens the running instance
  instead of starting another one. The log goes to `%TEMP%\webpulse.log`, and
  a fatal error is shown in a message box. Started from cmd or PowerShell,
  WebPulse behaves as before.
- `webpulse.exe` has an icon: the square-wave logo from the UI, made from the
  favicon at build time (`tools/make_icon.py`).
- The Windows CI artifact unzips straight to `webpulse.exe` and its files
  (no zip inside the zip).

## 0.2.2

- The UI opens in the default browser by default (Windows, and Linux desktop
  sessions); `--no-browser` turns it off. `--browser` is still accepted.
- Releases no longer include the CI screenshots as assets.

## 0.2.1

- `--browser` opens the UI in the default browser once the server is up.
- README in Traditional Chinese (`README.zh-TW.md`), screenshots and an
  animated demo (made by `tools/docshots.mjs` in headless Chrome).

## 0.2.0

- Protocol decoders: UART, SPI, I²C, Parallel and Counter, shown as rows
  below the channels; your own decoders as JavaScript files in `decoders/`
  (see README). New `/api/transitions` and `/api/decoders` endpoints.
- Open and save sigrok / PulseView session files (`.sr`), in the UI (also by
  dropping a file) and on the command line (`--open`, `-o file.sr`).
- Save the view as PNG.
- Access token for remote browsers: with `--listen` on a non-local address a
  random token is required (printed at start-up; `--token`, `--no-auth`).
  Connections from the same computer need none.
- Light theme (or follow the system); one Run/Stop button.
- Reorder channels by dragging.
- New decoders pick channels by name (e.g. a channel named "SCLK" or "SDA").
- If the default port 9002 is taken, use the next free one up to 9011 (not
  when `-p` is given) and print the address actually used.
- When the HTTP server cannot listen, say why (port in use, reserved by
  Windows, …) instead of "Failed to setup server ports".
- README: how to get past the SmartScreen warning for the unsigned exe, and
  Linux / Docker setup (udev rule, USB passthrough); tested on Linux in a
  container at 24 MHz × 256M samples.
- CI: headless Chrome checks of the UI; the release packages now include
  `decoders/` with an example decoder.

## 0.1.0

First release.

- Fixed-length capture from FX2 boards running fx2lafw (WeAct
  LogicAnalyzerV1 / CBM9002A and compatibles), up to 24 MHz on 8 channels.
  Tested at 24 MHz × 256M samples on Linux and 24 MHz × 30M on Windows.
  The firmware is uploaded automatically.
- Software trigger per channel (0, 1, rising, falling, either edge), with an
  adjustable pre-trigger share and timeout.
- Browser UI: the waveform view stays fast for any capture length because it
  only fetches what is on screen.
  - Zoom by double-click (left in, right out, Ctrl ×8), the wheel or the
    toolbar; drag to pan; Back returns to the previous view.
  - Cursors A/B with Δt and 1/Δt; they snap to edges, and `[` `]` step from
    edge to edge.
  - Live high/low time, period, frequency and duty of the pulse under the
    pointer.
  - Channel names and colours; a PulseView-style picker to show or hide
    channels (all, changing, non-changing, named, unnamed).
- Export to VCD and CSV (only the shown channels), from the UI, the HTTP API or
  the command line (`webpulse -c … -o file.vcd`).
- One self-contained executable on Windows; Linux build with a static libusb.
  Default port 9002; `--listen 0.0.0.0` for remote browsers.
