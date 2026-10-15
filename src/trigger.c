#include "trigger.h"

#include <string.h>

int wp_trigger_parse(const char *spec, wp_trigger *t)
{
    size_t i, len;

    memset(t, 0, sizeof(*t));
    if (!spec || !*spec)
        return 0;
    len = strlen(spec);
    if (len != WP_CHANNELS)
        return -1;
    for (i = 0; i < len; i++) {
        uint8_t bit = (uint8_t)(1u << i);
        switch (spec[i]) {
        case 'X': case 'x': break;
        case '0': t->lvl_mask |= bit; break;
        case '1': t->lvl_mask |= bit; t->lvl_val |= bit; break;
        case 'R': case 'r': t->rise |= bit; break;
        case 'F': case 'f': t->fall |= bit; break;
        case 'E': case 'e': t->any |= bit; break;
        default: return -1;
        }
    }
    return 0;
}

void wp_trigger_format(const wp_trigger *t, char *buf)
{
    int i;
    for (i = 0; i < WP_CHANNELS; i++) {
        uint8_t bit = (uint8_t)(1u << i);
        char c = 'X';
        if (t->lvl_mask & bit)
            c = (t->lvl_val & bit) ? '1' : '0';
        else if (t->rise & bit)
            c = 'R';
        else if (t->fall & bit)
            c = 'F';
        else if (t->any & bit)
            c = 'E';
        buf[i] = c;
    }
    buf[WP_CHANNELS] = '\0';
}

int wp_trigger_is_none(const wp_trigger *t)
{
    return !(t->lvl_mask | t->rise | t->fall | t->any);
}

int wp_trigger_has_edge(const wp_trigger *t)
{
    return (t->rise | t->fall | t->any) != 0;
}

static inline int match(const wp_trigger *t, uint8_t prev, uint8_t s)
{
    uint8_t changed = prev ^ s;
    return (s & t->lvl_mask) == t->lvl_val &&
           (changed & s & t->rise) == t->rise &&
           (changed & (uint8_t)~s & t->fall) == t->fall &&
           (changed & t->any) == t->any;
}

ptrdiff_t wp_trigger_find(const wp_trigger *t, uint8_t prev, int have_prev,
                          const uint8_t *buf, size_t n)
{
    size_t i = 0;

    if (n == 0)
        return -1;
    if (wp_trigger_is_none(t))
        return 0;

    if (!wp_trigger_has_edge(t)) {
        for (; i < n; i++)
            if ((buf[i] & t->lvl_mask) == t->lvl_val)
                return (ptrdiff_t)i;
        return -1;
    }

    if (!have_prev) {
        prev = buf[0];
        i = 1;
    }
    while (i < n) {
        /* Fast path: an edge trigger cannot fire inside a run of identical
         * samples, so skip 8 samples at a time while they all equal prev. */
        if (i + 8 <= n) {
            uint64_t w, rep = 0x0101010101010101ull * prev;
            memcpy(&w, buf + i, 8);
            if (w == rep) {
                i += 8;
                continue;
            }
        }
        if (match(t, prev, buf[i]))
            return (ptrdiff_t)i;
        prev = buf[i];
        i++;
    }
    return -1;
}
