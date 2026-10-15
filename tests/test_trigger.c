#include "test.h"
#include "trigger.h"

#include <string.h>

/* Reference implementation: check every sample one by one. */
static ptrdiff_t ref_find(const wp_trigger *t, uint8_t prev, int have_prev,
                          const uint8_t *b, size_t n)
{
    size_t i;
    if (wp_trigger_is_none(t))
        return n ? 0 : -1;
    for (i = 0; i < n; i++) {
        uint8_t p = i ? b[i - 1] : prev;
        uint8_t ch = p ^ b[i];
        int edge_ok = 1;
        if (wp_trigger_has_edge(t)) {
            if (i == 0 && !have_prev)
                continue;
            edge_ok = (ch & b[i] & t->rise) == t->rise &&
                      (ch & (uint8_t)~b[i] & t->fall) == t->fall &&
                      (ch & t->any) == t->any;
        }
        if ((b[i] & t->lvl_mask) == t->lvl_val && edge_ok)
            return (ptrdiff_t)i;
    }
    return -1;
}

int main(void)
{
    wp_trigger t;
    char buf[9];
    uint8_t data[4096];
    unsigned seed = 1;
    int round;
    const char *specs[] = { "XXXXXXXR", "1XXXXXXX", "R0XXXXXX", "XXFXXXXX",
                            "EXXXXXX1", "RRXXXXXX", "X1X0XXXF", "XXXXXXXX" };

    CHECK(wp_trigger_parse("XX1RFE0x", &t) == 0);
    wp_trigger_format(&t, buf);
    CHECK(strcmp(buf, "XX1RFE0X") == 0);
    CHECK(t.lvl_mask == ((1 << 2) | (1 << 6)));
    CHECK(t.lvl_val == (1 << 2));
    CHECK(t.rise == (1 << 3) && t.fall == (1 << 4) && t.any == (1 << 5));
    CHECK(wp_trigger_parse("XXX", &t) < 0);
    CHECK(wp_trigger_parse("XXXXXXXQ", &t) < 0);
    CHECK(wp_trigger_parse("", &t) == 0 && wp_trigger_is_none(&t));
    CHECK(wp_trigger_parse(NULL, &t) == 0 && wp_trigger_is_none(&t));

    /* Rising edge on CH7 after a long constant run (exercises the fast path) */
    memset(data, 0, sizeof(data));
    data[1000] = 0x80;
    wp_trigger_parse("XXXXXXXR", &t);
    CHECK(wp_trigger_find(&t, 0, 1, data, sizeof(data)) == 1000);
    /* Edge across a buffer boundary */
    CHECK(wp_trigger_find(&t, 0x00, 1, data + 1000, 10) == 0);
    CHECK(wp_trigger_find(&t, 0x80, 1, data + 1000, 10) == -1);
    CHECK(wp_trigger_find(&t, 0x00, 0, data + 1000, 10) == -1);

    /* Randomised comparison with the reference */
    for (round = 0; round < 400; round++) {
        size_t i, n = 1 + (size_t)(round * 37 % sizeof(data));
        uint8_t prev;
        int have_prev = round & 1;
        uint8_t level = 0;
        for (i = 0; i < n; i++) {
            seed = seed * 1103515245u + 12345u;
            if (((seed >> 16) & 63) == 0)       /* sparse changes */
                level ^= (uint8_t)(1u << ((seed >> 8) & 7));
            data[i] = level;
        }
        prev = (uint8_t)(seed >> 3);
        wp_trigger_parse(specs[round % 8], &t);
        CHECK(wp_trigger_find(&t, prev, have_prev, data, n) ==
              ref_find(&t, prev, have_prev, data, n));
    }
    TEST_DONE();
}
