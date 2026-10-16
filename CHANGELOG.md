# Changelog

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
