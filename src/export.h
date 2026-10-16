/* VCD / CSV export of a completed capture through a generic writer. */
#ifndef WP_EXPORT_H
#define WP_EXPORT_H

#include "capture_store.h"

/* Return 0 on success, non-zero aborts the export. */
typedef int (*wp_write_fn)(void *ctx, const void *data, size_t len);

/* names: 8 channel names (indexed by channel) or NULL for ch0..ch7. Invalid
 * characters are replaced with '_'. mask: bit c set = include CHc; WP_ALL_CHANNELS
 * for all. Returns 0 on success. */
#define WP_ALL_CHANNELS 0xffu
int wp_export_vcd(const wp_store *s, const char *const *names, unsigned mask,
                  wp_write_fn fn, void *ctx);

/* changes_only: emit only the first sample, samples where any included
 * channel changed, and the last sample. Columns: sample,time_ns,<names...> */
int wp_export_csv(const wp_store *s, const char *const *names, unsigned mask,
                  int changes_only, wp_write_fn fn, void *ctx);

/* Parse a channel list such as "0-3,6" into a mask. Returns -1 if invalid
 * or empty. */
int wp_parse_channels(const char *s, unsigned *mask);

/* Write callback for a FILE*. */
int wp_write_file(void *ctx, const void *data, size_t len);

#endif
