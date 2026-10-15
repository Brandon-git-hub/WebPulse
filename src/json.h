/*
 * Minimal JSON helpers for the flat request objects the web UI sends
 * (e.g. {"rate":24000000,"trigger":"XXXXXXXR"}). Not a general parser:
 * keys are looked up at the top level of a single object.
 */
#ifndef WP_JSON_H
#define WP_JSON_H

#include <stddef.h>

/* Return 0 if found. */
int wp_json_num(const char *js, size_t len, const char *key, double *out);
int wp_json_str(const char *js, size_t len, const char *key, char *out, size_t outlen);

/* Escape s as a JSON string body (no quotes) into out. Returns length. */
size_t wp_json_escape(const char *s, char *out, size_t outlen);

#endif
