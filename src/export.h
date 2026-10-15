/* VCD / CSV export of a completed capture through a generic writer. */
#ifndef WP_EXPORT_H
#define WP_EXPORT_H

#include "capture_store.h"

/* Return 0 on success, non-zero aborts the export. */
typedef int (*wp_write_fn)(void *ctx, const void *data, size_t len);

/* names: 8 channel names or NULL for ch0..ch7. Invalid characters are
 * replaced with '_'. Returns 0 on success. */
int wp_export_vcd(const wp_store *s, const char *const *names, wp_write_fn fn, void *ctx);

/* changes_only: emit only the first sample, samples where any channel
 * changed, and the last sample. Columns: sample,time_ns,<names...> */
int wp_export_csv(const wp_store *s, const char *const *names, int changes_only,
                  wp_write_fn fn, void *ctx);

/* Write callback for a FILE*. */
int wp_write_file(void *ctx, const void *data, size_t len);

#endif
