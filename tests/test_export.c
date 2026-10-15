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
    CHECK(wp_export_vcd(s, names, mem_write, &m) == 0);
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
    CHECK(wp_export_csv(s, NULL, 1, mem_write, &m) == 0);
    CHECK(strncmp(m.buf, "sample,time_ns,ch0,ch1,ch2,ch3,ch4,ch5,ch6,ch7\n", 47) == 0);
    CHECK(strstr(m.buf, "0,0.000,0,0,0,0,0,0,0,0\n2,2000.000,1,0,") != NULL);
    CHECK(strstr(m.buf, "\n1,") == NULL);          /* unchanged sample skipped */
    CHECK(strstr(m.buf, "\n7,7000.000,0,1,0,0,0,0,0,1\n") != NULL);

    wp_store_unref(s);

    /* 24 MHz: non-integer ns period -> ps timescale, rounding down */
    raw = malloc(2);
    raw[0] = 0;
    raw[1] = 1;
    s = wp_store_new(raw, 2, 24000000, -1);
    memset(&m, 0, sizeof(m));
    CHECK(wp_export_vcd(s, NULL, mem_write, &m) == 0);
    CHECK(strstr(m.buf, "$timescale 1 ps $end") != NULL);
    CHECK(strstr(m.buf, "#41666\n1!\n#83333\n") != NULL);
    CHECK(strstr(m.buf, "trigger") == NULL);
    wp_store_unref(s);
    TEST_DONE();
}
