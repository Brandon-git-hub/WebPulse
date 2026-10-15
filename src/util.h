/* Parsing / formatting helpers shared by CLI and server. */
#ifndef WP_UTIL_H
#define WP_UTIL_H

#include <stddef.h>
#include <stdint.h>

/* Parse "24M", "10k", "1.5G", "1000" (decimal SI suffixes). Returns 0 on success. */
int wp_parse_si(const char *s, uint64_t *out);

/* Format a sample rate, e.g. 24000000 -> "24 MHz". */
void wp_format_rate(uint64_t rate, char *buf, size_t len);

/* Time of sample index i in picoseconds (floor). */
uint64_t wp_sample_to_ps(uint64_t i, uint64_t rate);

/* Smallest sample index whose time is >= t_ps. */
uint64_t wp_ps_to_sample_ceil(uint64_t t_ps, uint64_t rate);

/* Copy at most dstlen-1 bytes and always NUL-terminate. */
void wp_strlcpy(char *dst, const char *src, size_t dstlen);

#endif
