/*
 * Capture engine: runs one fixed-length acquisition at a time.
 *
 *   start() -> [ARMED: filling pre-trigger ring, searching trigger]
 *           -> [CAPTURING: filling post-trigger samples]
 *           -> [PROCESSING: building the mipmap]
 *           -> DONE (store available) | ERROR | IDLE (stopped before trigger)
 */
#ifndef WP_CAPTURE_H
#define WP_CAPTURE_H

#include "capture_store.h"
#include "device.h"

#include <stdint.h>

typedef enum {
    WP_ST_IDLE,
    WP_ST_ARMED,
    WP_ST_CAPTURING,
    WP_ST_PROCESSING,
    WP_ST_DONE,
    WP_ST_ERROR,
} wp_state;

typedef struct {
    uint64_t rate;
    uint64_t samples;
    double pre_ratio;           /* 0..1, fraction of samples before the trigger */
    char trigger[16];           /* see trigger.h; "" = none */
    uint32_t timeout_ms;        /* trigger wait timeout, 0 = forever */
} wp_capture_cfg;

typedef struct {
    wp_state state;
    uint32_t seq;               /* increments on every state change */
    uint64_t rate;
    uint64_t samples;           /* requested */
    uint64_t filled;            /* samples stored so far */
    int64_t trigger_pos;        /* -1 until triggered / if no trigger */
    uint64_t elapsed_ms;
    char trigger[16];
    char error[160];
} wp_capture_status;

typedef struct wp_engine wp_engine;

wp_engine *wp_engine_new(wp_device *dev, uint64_t max_samples);
void wp_engine_free(wp_engine *e);

/* Returns 0 on success; on failure writes a message into err. */
int wp_engine_start(wp_engine *e, const wp_capture_cfg *cfg, char *err, size_t errlen);
/* Request stop. If triggered, keeps the samples captured so far. */
void wp_engine_stop(wp_engine *e);
/* Block until the engine is not busy or timeout_ms passes. Returns 1 if idle. */
int wp_engine_wait(wp_engine *e, uint32_t timeout_ms);
int wp_engine_busy(wp_engine *e);

void wp_engine_status(wp_engine *e, wp_capture_status *st);
uint64_t wp_engine_max_samples(wp_engine *e);
wp_device *wp_engine_device(wp_engine *e);

/*
 * Make samples loaded from a file the current capture (state DONE). Takes
 * ownership of raw (malloc'd, freed on failure too). names (may be NULL) are
 * the file's channel names; note, if not NULL, is shown with the capture
 * like a device note. Fails while a capture runs.
 */
int wp_engine_load(wp_engine *e, uint8_t *raw, uint64_t n, uint64_t rate, int64_t trigger_pos,
                   const char names[8][32], const char *note, char *err, size_t errlen);

/* Returns a referenced store or NULL; release with wp_store_unref(). */
wp_store *wp_engine_store(wp_engine *e);

const char *wp_state_name(wp_state s);

#endif
