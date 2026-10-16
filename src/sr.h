/*
 * sigrok session files (.sr, format version 2), as written and read by
 * PulseView / sigrok-cli: a ZIP archive with
 *   version      "2"
 *   metadata     INI text: [device 1] samplerate=24 MHz, total probes=8,
 *                probe1=CH0 ..., unitsize=1, capturefile=logic-1
 *   logic-1-1, logic-1-2, ...   raw samples, concatenated in order
 * WebPulse adds a "webpulse" member (trigger position), which sigrok ignores.
 */
#ifndef WP_SR_H
#define WP_SR_H

#include "capture_store.h"
#include "export.h"

/* Write the capture. names: 8 names or NULL; mask: channels to list as
 * probes (the samples always hold all 8). Returns 0 on success. */
int wp_sr_write(const wp_store *s, const char *const *names, unsigned mask,
                wp_write_fn fn, void *ctx);

typedef struct {
    uint8_t *raw;           /* malloc'd samples, one byte each (CH0 = bit 0) */
    uint64_t n;
    uint64_t rate;
    int64_t trigger_pos;    /* -1 if unknown */
    char names[8][32];      /* "" where the file has no probe */
    unsigned mask;          /* probes present in the file */
    char note[128];         /* e.g. "only the first 8 of 16 channels were loaded" */
} wp_sr_capture;

/* Parse a session file held in memory. On success fills *out (the caller
 * frees out->raw) and returns 0; on failure returns -1 with err set. */
int wp_sr_read(const uint8_t *buf, size_t len, uint64_t max_samples, wp_sr_capture *out,
               char *err, size_t errlen);

#endif
