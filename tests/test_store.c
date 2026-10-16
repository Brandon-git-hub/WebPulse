#include "capture_store.h"
#include "test.h"

#include <string.h>

int main(void)
{
    const uint64_t N = 1000003;     /* not a multiple of 16 */
    uint8_t *raw = malloc(N);
    uint8_t *copy = malloc(N);
    uint8_t out[8192], mode;
    uint64_t i, t1;
    unsigned seed = 7;
    wp_store *s;
    int round;
    size_t len;

    uint8_t level = 0;
    for (i = 0; i < N; i++) {
        seed = seed * 1103515245u + 12345u;
        if (((seed >> 16) & 255) == 0)
            level ^= (uint8_t)(1u << ((seed >> 8) & 7));
        raw[i] = level;
    }
    memcpy(copy, raw, N);
    s = wp_store_new(raw, N, 24000000, 1234);
    CHECK(s != NULL);
    CHECK(s->nlevels >= 4);
    CHECK_EQ_U(s->trigger_pos, 1234);
    {
        uint8_t o = 0, a = 0xff;
        for (i = 0; i < N; i++) {
            o |= copy[i];
            a &= copy[i];
        }
        CHECK_EQ_U(s->changing, (uint8_t)(o & ~a));
        CHECK(s->changing != 0);
    }

    /* wp_store_range == brute force */
    for (round = 0; round < 2000; round++) {
        uint64_t a, b, j;
        uint8_t o, an, ro = 0, ran = 0xff;
        seed = seed * 1103515245u + 12345u;
        a = (seed >> 4) % N;
        seed = seed * 1103515245u + 12345u;
        b = a + 1 + (seed >> 4) % (round < 1000 ? 5000 : N);
        if (b > N)
            b = N;
        for (j = a; j < b; j++) {
            ro |= copy[j];
            ran &= copy[j];
        }
        wp_store_range(s, a, b, &o, &an);
        CHECK(o == ro);
        CHECK(an == ran);
    }

    /* Raw mode */
    len = wp_store_query(s, 100, 150, 800, out, sizeof(out), &mode, &t1);
    CHECK(mode == WP_QUERY_RAW);
    CHECK_EQ_U(len, 50);
    CHECK(memcmp(out, copy + 100, 50) == 0);

    /* Clamp t1 to n */
    len = wp_store_query(s, N - 10, N + 100, 800, out, sizeof(out), &mode, &t1);
    CHECK(mode == WP_QUERY_RAW);
    CHECK_EQ_U(len, 10);
    CHECK_EQ_U(t1, N);

    /* Summary mode, compare one pixel against brute force */
    len = wp_store_query(s, 0, N, 1000, out, sizeof(out), &mode, &t1);
    CHECK(mode == WP_QUERY_SUMMARY);
    CHECK_EQ_U(len, 2000);
    {
        int p;
        for (p = 0; p < 1000; p += 97) {
            uint64_t a = N * (uint64_t)p / 1000, b = N * (uint64_t)(p + 1) / 1000, j;
            uint8_t ro = 0, ran = 0xff;
            uint16_t v = (uint16_t)(out[2 * p] | (out[2 * p + 1] << 8)), exp = 0;
            int c;
            for (j = a; j < b; j++) {
                ro |= copy[j];
                ran &= copy[j];
            }
            for (c = 0; c < 8; c++) {
                if ((ro >> c) & 1)
                    exp |= (uint16_t)(1u << (2 * c));
                if (!((ran >> c) & 1))
                    exp |= (uint16_t)(1u << (2 * c + 1));
            }
            CHECK(v == exp);
        }
    }
    wp_store_unref(s);
    free(copy);
    TEST_DONE();
}
