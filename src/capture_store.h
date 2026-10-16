/*
 * Completed capture: raw 8-bit samples plus a mipmap pyramid used to answer
 * viewport queries in time proportional to the output width.
 *
 * Level k summarises blocks of 16^(k+1) samples with an OR byte and an AND
 * byte. For channel c within a range: OR bit set => the channel was high at
 * least once, AND bit clear => it was low at least once.
 */
#ifndef WP_CAPTURE_STORE_H
#define WP_CAPTURE_STORE_H

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

#define WP_STORE_MAX_LEVELS 16
#define WP_STORE_FANOUT 16

/* Viewport query result modes */
#define WP_QUERY_RAW     0  /* payload: u8 sample per index in [t0, t1) */
#define WP_QUERY_SUMMARY 1  /* payload: u16 LE per pixel, bit 2c = high seen, 2c+1 = low seen */

typedef struct {
    uint8_t *d;         /* interleaved [or, and] pairs */
    uint64_t n;         /* number of blocks */
    uint64_t block;     /* samples per block */
} wp_store_level;

typedef struct wp_store {
    _Atomic int refs;
    uint8_t *raw;
    uint64_t n;
    uint64_t rate;
    int64_t trigger_pos;        /* sample index, -1 if untriggered */
    uint8_t changing;           /* bit c set = CHc has both levels in the capture */
    int nlevels;
    wp_store_level lv[WP_STORE_MAX_LEVELS];
} wp_store;

/* Takes ownership of raw (malloc'd). Returns NULL on allocation failure
 * (raw is freed in that case). The new store has one reference. */
wp_store *wp_store_new(uint8_t *raw, uint64_t n, uint64_t rate, int64_t trigger_pos);
void wp_store_ref(wp_store *s);
void wp_store_unref(wp_store *s);

/* OR / AND of all samples in [a, b). a < b <= n. */
void wp_store_range(const wp_store *s, uint64_t a, uint64_t b,
                    uint8_t *or_out, uint8_t *and_out);

/*
 * Answer a viewport query over [t0, t1) rendered into width pixels.
 * t1 is clamped to n. Writes the payload into out (capacity outcap) and
 * returns its length; *mode receives WP_QUERY_RAW or WP_QUERY_SUMMARY.
 * Raw mode is used when (t1 - t0) <= width. *t1_out receives the clamped t1.
 */
size_t wp_store_query(const wp_store *s, uint64_t t0, uint64_t t1, uint32_t width,
                      uint8_t *out, size_t outcap, uint8_t *mode, uint64_t *t1_out);

/* Worst-case payload size for a query of the given width. */
size_t wp_store_query_max(uint32_t width);

/*
 * Edges of channel ch. An edge "at i" means sample i differs from sample i-1,
 * i.e. i is the first sample of the new level.
 *   next: smallest i > from with an edge at i
 *   prev: largest i <= from with an edge at i (start of the level containing from)
 * Both return -1 if there is none. Uses the mipmap to skip constant blocks.
 */
int64_t wp_store_next_edge(const wp_store *s, int ch, uint64_t from);
int64_t wp_store_prev_edge(const wp_store *s, int ch, uint64_t from);

#endif
