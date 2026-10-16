/* ZIP / deflate / inflate and sigrok session (.sr) read and write. */
#include "sr.h"
#include "test.h"
#include "zip.h"

#include <string.h>

#include "sr_fixtures.h"

typedef struct {
    uint8_t *buf;
    size_t len, cap;
} membuf;

static int mem_write(void *ctx, const void *d, size_t n)
{
    membuf *m = ctx;
    if (m->len + n > m->cap) {
        size_t cap = m->cap ? m->cap * 2 : 65536;
        while (cap < m->len + n)
            cap *= 2;
        m->buf = realloc(m->buf, cap);
        m->cap = cap;
    }
    memcpy(m->buf + m->len, d, n);
    m->len += n;
    return 0;
}

static void roundtrip(const uint8_t *data, size_t len, const char *what)
{
    size_t clen = 0;
    uint8_t *c = wp_deflate(data, len, &clen);
    uint8_t *back = malloc(len + 1);
    CHECK(c != NULL);
    CHECK(wp_inflate(c, clen, back, len) == 0);
    CHECK(memcmp(back, data, len) == 0);
    fprintf(stderr, "  deflate %-12s %8zu -> %7zu bytes\n", what, len, clen);
    free(c);
    free(back);
}

int main(void)
{
    /* CRC-32 check value */
    CHECK_EQ_U(wp_crc32(0, "123456789", 9), 0xcbf43926u);

    /* deflate -> inflate on runs, noise, logic-like data and edge sizes */
    {
        size_t n = 3u << 20, i;
        uint8_t *d = malloc(n);
        unsigned seed = 3;
        memset(d, 0x5a, n);
        roundtrip(d, n, "constant");
        for (i = 0; i < n; i++) {
            seed = seed * 1103515245u + 12345u;
            d[i] = (uint8_t)(seed >> 16);
        }
        roundtrip(d, 70000, "noise");
        for (i = 0; i < n; i++) {
            seed = seed * 1103515245u + 12345u;
            d[i] = i ? (((seed >> 16) & 255) < 3 ? d[i - 1] ^ (uint8_t)(1u << ((seed >> 8) & 7)) : d[i - 1]) : 0;
        }
        roundtrip(d, n, "logic");
        roundtrip(d, 1, "1 byte");
        roundtrip(d, 0, "empty");
        free(d);
    }

    /* inflate a zlib stream with dynamic Huffman blocks */
    {
        uint8_t *out = malloc(ZLIB_PLAIN_LEN);
        CHECK(wp_inflate(zlib_raw, sizeof(zlib_raw), out, ZLIB_PLAIN_LEN) == 0);
        CHECK_EQ_U(wp_crc32(0, out, ZLIB_PLAIN_LEN), ZLIB_PLAIN_CRC);
        /* truncated or with a wrong size it must fail, not crash */
        CHECK(wp_inflate(zlib_raw, sizeof(zlib_raw) / 2, out, ZLIB_PLAIN_LEN) != 0);
        CHECK(wp_inflate(zlib_raw, sizeof(zlib_raw), out, ZLIB_PLAIN_LEN - 1) != 0);
        free(out);
    }

    /* read files as PulseView writes them */
    {
        wp_sr_capture c;
        char err[160];
        CHECK(wp_sr_read(pulseview_8ch, sizeof(pulseview_8ch), 1u << 30, &c, err, sizeof(err)) == 0);
        CHECK_EQ_U(c.n, 3000);
        CHECK_EQ_U(c.rate, 2000000);
        CHECK_EQ_U(c.trigger_pos, (uint64_t)-1);
        CHECK(strcmp(c.names[1], "clk") == 0 && strcmp(c.names[2], "mosi") == 0);
        CHECK_EQ_U(c.mask, 0xff);
        CHECK_EQ_U(wp_crc32(0, c.raw, (size_t)c.n), PV8_CRC);
        CHECK(c.note[0] == '\0');
        free(c.raw);

        CHECK(wp_sr_read(pulseview_16ch, sizeof(pulseview_16ch), 1u << 30, &c, err, sizeof(err)) == 0);
        CHECK_EQ_U(c.n, 2000);
        CHECK_EQ_U(wp_crc32(0, c.raw, (size_t)c.n), PV16_LOW_CRC);
        CHECK(strstr(c.note, "first 8 of 16") != NULL);
        free(c.raw);

        CHECK(wp_sr_read(pulseview_8ch, sizeof(pulseview_8ch), 100, &c, err, sizeof(err)) != 0);
        CHECK(strstr(err, "limit") != NULL);
        CHECK(wp_sr_read((const uint8_t *)"PK\x05\x06 nonsense", 16, 1000, &c, err, sizeof(err)) != 0);
    }

    /* write -> read: samples, rate, names, shown channels, trigger position */
    {
        size_t n = 9u << 20, i;     /* more than one 4 MiB member */
        uint8_t *raw = malloc(n);
        unsigned seed = 9;
        wp_store *s;
        membuf m = { 0 };
        const char *names[8] = { "uart", NULL, "sp ace", "x=y", NULL, NULL, NULL, "irq" };
        wp_sr_capture c;
        char err[160];
        uint32_t crc;
        for (i = 0; i < n; i++) {
            seed = seed * 1103515245u + 12345u;
            raw[i] = i ? (((seed >> 16) & 1023) == 0 ? (uint8_t)(seed >> 8) : raw[i - 1]) : 0x11;
        }
        crc = wp_crc32(0, raw, n);
        s = wp_store_new(raw, n, 24000000, 123456);
        CHECK(wp_sr_write(s, names, 0x8d, mem_write, &m) == 0);   /* CH0, 2, 3, 7 */
        fprintf(stderr, "  .sr of %zu samples: %zu bytes\n", n, m.len);
        CHECK(m.len < n / 10);
        CHECK(wp_sr_read(m.buf, m.len, 1u << 30, &c, err, sizeof(err)) == 0);
        CHECK_EQ_U(c.n, n);
        CHECK_EQ_U(c.rate, 24000000);
        CHECK_EQ_U(c.trigger_pos, 123456);
        CHECK_EQ_U(c.mask, 0x8d);
        CHECK(strcmp(c.names[0], "uart") == 0 && strcmp(c.names[2], "sp ace") == 0 &&
              strcmp(c.names[3], "x_y") == 0 && strcmp(c.names[7], "irq") == 0 && c.names[1][0] == 0);
        CHECK_EQ_U(wp_crc32(0, c.raw, n), crc);
        free(c.raw);
        free(m.buf);
        wp_store_unref(s);
    }
    TEST_DONE();
}
