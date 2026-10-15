/*
 * Software trigger for 8-bit samples.
 *
 * A trigger spec is an 8-character string, character i applies to channel i:
 *   X  don't care      0  low         1  high
 *   R  rising edge     F  falling     E  either edge
 * All conditions are ANDed. An all-X spec means "no trigger".
 */
#ifndef WP_TRIGGER_H
#define WP_TRIGGER_H

#include <stddef.h>
#include <stdint.h>

#define WP_CHANNELS 8

typedef struct {
    uint8_t lvl_mask;   /* channels with a level condition */
    uint8_t lvl_val;    /* required levels for those channels */
    uint8_t rise;       /* channels that must rise */
    uint8_t fall;       /* channels that must fall */
    uint8_t any;        /* channels that must change */
} wp_trigger;

/* Returns 0 on success, -1 on a malformed spec. NULL or "" means no trigger. */
int wp_trigger_parse(const char *spec, wp_trigger *t);

/* Inverse of parse; buf must hold WP_CHANNELS + 1 bytes. */
void wp_trigger_format(const wp_trigger *t, char *buf);

int wp_trigger_is_none(const wp_trigger *t);
int wp_trigger_has_edge(const wp_trigger *t);

/*
 * Find the first sample in buf[0..n) that satisfies the trigger.
 * prev is the sample preceding buf[0]; if have_prev is 0, edge conditions
 * cannot match at buf[0]. Returns the index, or -1 if not found.
 */
ptrdiff_t wp_trigger_find(const wp_trigger *t, uint8_t prev, int have_prev,
                          const uint8_t *buf, size_t n);

#endif
