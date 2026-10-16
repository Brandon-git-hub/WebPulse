#include "export.h"
#include "test.h"

#include <string.h>

typedef struct {
    char buf[4096];
    size_t len;
} membuf;

static int mem_write(void *ctx, const void *d, size_t n)
{
    membuf *m = ctx;
    if (m->len + n >= sizeof(m->buf))
        return -1;
    memcpy(m->buf + m->len, d, n);
    m->len += n;
    m->buf[m->len] = '\0';
    return 0;
}

int main(void)
{
    static const uint8_t samples[] = { 0x00, 0x00, 0x01, 0x01, 0x03, 0x02, 0x02, 0x82 };
    uint8_t *raw = malloc(sizeof(samples));
    wp_store *s;
    membuf m;
    const char *names[8] = { "clk", "data bus", NULL, NULL, NULL, NULL, NULL, "irq" };

    memcpy(raw, samples, sizeof(samples));
    s = wp_store_new(raw, sizeof(samples), 1000000, 2);   /* 1 MHz -> 1 us period */

    memset(&m, 0, sizeof(m));
    CHECK(wp_export_vcd(s, names, WP_ALL_CHANNELS, mem_write, &m) == 0);
    CHECK(strstr(m.buf, "$timescale 1 ns $end") != NULL);
    CHECK(strstr(m.buf, "trigger at sample 2") != NULL);
    CHECK(strstr(m.buf, "$var wire 1 ! clk $end") != NULL);
    CHECK(strstr(m.buf, "$var wire 1 \" data_bus $end") != NULL);
    CHECK(strstr(m.buf, "$var wire 1 # ch2 $end") != NULL);
    CHECK(strstr(m.buf, "$var wire 1 ( irq $end") != NULL);
    CHECK(strstr(m.buf, "#0\n$dumpvars\n0!\n0\"\n") != NULL);
    CHECK(strstr(m.buf, "#2000\n1!\n#4000\n1\"\n#5000\n0!\n#7000\n1(\n#8000\n") != NULL);
    CHECK(strstr(m.buf, "#1000") == NULL);   /* no change at sample 1 */

    memset(&m, 0, sizeof(m));
    CHECK(wp_export_csv(s, NULL, WP_ALL_CHANNELS, 1, mem_write, &m) == 0);
    CHECK(strncmp(m.buf, "sample,time_ns,ch0,ch1,ch2,ch3,ch4,ch5,ch6,ch7\n", 47) == 0);
    CHECK(strstr(m.buf, "0,0.000,0,0,0,0,0,0,0,0\n2,2000.000,1,0,") != NULL);
    CHECK(strstr(m.buf, "\n1,") == NULL);          /* unchanged sample skipped */
    CHECK(strstr(m.buf, "\n7,7000.000,0,1,0,0,0,0,0,1\n") != NULL);

    /* Only CH1 and CH7: CH0 changes are dropped, ids stay per channel. */
    memset(&m, 0, sizeof(m));
    CHECK(wp_export_vcd(s, names, 0x82, mem_write, &m) == 0);
    CHECK(strstr(m.buf, " clk ") == NULL && strstr(m.buf, " ch2 ") == NULL);
    CHECK(strstr(m.buf, "$var wire 1 \" data_bus $end\n$var wire 1 ( irq $end") != NULL);
    CHECK(strstr(m.buf, "$dumpvars\n0\"\n0(\n$end") != NULL);
    CHECK(strstr(m.buf, "#4000\n1\"\n#7000\n1(\n#8000\n") != NULL);
    CHECK(strstr(m.buf, "#2000") == NULL && strstr(m.buf, "#5000") == NULL);

    memset(&m, 0, sizeof(m));
    CHECK(wp_export_csv(s, NULL, 0x82, 1, mem_write, &m) == 0);
    CHECK(strcmp(m.buf, "sample,time_ns,ch1,ch7\n0,0.000,0,0\n4,4000.000,1,0\n"
                        "7,7000.000,1,1\n") == 0);

    {
        unsigned mask = 0;
        CHECK(wp_parse_channels("0-3,6", &mask) == 0 && mask == 0x4f);
        CHECK(wp_parse_channels("7", &mask) == 0 && mask == 0x80);
        CHECK(wp_parse_channels("", &mask) < 0);
        CHECK(wp_parse_channels("8", &mask) < 0);
        CHECK(wp_parse_channels("3-1", &mask) < 0);
        CHECK(wp_parse_channels("1,x", &mask) < 0);
    }

    wp_store_unref(s);

    /* 24 MHz: non-integer ns period -> ps timescale, rounding down */
    raw = malloc(2);
    raw[0] = 0;
    raw[1] = 1;
    s = wp_store_new(raw, 2, 24000000, -1);
    memset(&m, 0, sizeof(m));
    CHECK(wp_export_vcd(s, NULL, WP_ALL_CHANNELS, mem_write, &m) == 0);
    CHECK(strstr(m.buf, "$timescale 1 ps $end") != NULL);
    CHECK(strstr(m.buf, "#41666\n1!\n#83333\n") != NULL);
    CHECK(strstr(m.buf, "trigger") == NULL);
    wp_store_unref(s);
    TEST_DONE();
}
