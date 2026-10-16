#include "export.h"
#include "util.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define OUTBUF 65536

typedef struct {
    wp_write_fn fn;
    void *ctx;
    size_t len;
    int err;
    char buf[OUTBUF];
} outbuf;

static outbuf *ob_new(wp_write_fn fn, void *ctx)
{
    outbuf *o = malloc(sizeof(*o));
    if (o) {
        o->fn = fn;
        o->ctx = ctx;
        o->len = 0;
        o->err = 0;
    }
    return o;
}

static void ob_flush(outbuf *o)
{
    if (o->len && !o->err)
        o->err = o->fn(o->ctx, o->buf, o->len);
    o->len = 0;
}

static void ob_put(outbuf *o, const char *s, size_t n)
{
    if (o->len + n > OUTBUF)
        ob_flush(o);
    memcpy(o->buf + o->len, s, n);
    o->len += n;
}

static void ob_printf(outbuf *o, const char *fmt, ...)
#if defined(__GNUC__)
    __attribute__((format(printf, 2, 3)))
#endif
    ;

static void ob_printf(outbuf *o, const char *fmt, ...)
{
    char tmp[512];
    va_list ap;
    int n;
    va_start(ap, fmt);
    n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    if (n > 0)
        ob_put(o, tmp, (size_t)n < sizeof(tmp) ? (size_t)n : sizeof(tmp) - 1);
}

/* Write decimal u64 into p (no NUL), return length. */
static size_t u64_dec(char *p, uint64_t v)
{
    char tmp[24];
    size_t n = 0, i;
    do {
        tmp[n++] = (char)('0' + v % 10);
        v /= 10;
    } while (v);
    for (i = 0; i < n; i++)
        p[i] = tmp[n - 1 - i];
    return n;
}

static void channel_name(const char *const *names, int c, char *out, size_t len)
{
    size_t i;
    if (!names || !names[c] || !names[c][0]) {
        snprintf(out, len, "ch%d", c);
        return;
    }
    wp_strlcpy(out, names[c], len);
    for (i = 0; out[i]; i++) {
        char ch = out[i];
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
              (ch >= '0' && ch <= '9') || ch == '_' || ch == '.' || ch == '-'))
            out[i] = '_';
    }
}

int wp_parse_channels(const char *s, unsigned *mask)
{
    unsigned m = 0;
    while (*s) {
        int a, b;
        if (*s < '0' || *s > '7')
            return -1;
        a = b = *s++ - '0';
        if (*s == '-') {
            s++;
            if (*s < '0' || *s > '7')
                return -1;
            b = *s++ - '0';
            if (b < a)
                return -1;
        }
        for (; a <= b; a++)
            m |= 1u << a;
        if (*s == ',')
            s++;
        else if (*s)
            return -1;
    }
    if (!m)
        return -1;
    *mask = m;
    return 0;
}

int wp_export_vcd(const wp_store *s, const char *const *names, unsigned mask,
                  wp_write_fn fn, void *ctx)
{
    outbuf *o = ob_new(fn, ctx);
    uint64_t unit_per_s, i;
    uint8_t prev;
    int c, err;
    char rate_str[32];

    if (!o)
        return -1;

    /* Use 1 ns when the sample period is an integer number of ns, else 1 ps. */
    unit_per_s = (1000000000ull % s->rate == 0) ? 1000000000ull : 1000000000000ull;
    wp_format_rate(s->rate, rate_str, sizeof(rate_str));

    ob_printf(o, "$version WebPulse $end\n");
    ob_printf(o, "$comment\n  samplerate %s (%llu Hz), %llu samples",
              rate_str, (unsigned long long)s->rate, (unsigned long long)s->n);
    if (s->trigger_pos >= 0)
        ob_printf(o, ", trigger at sample %lld", (long long)s->trigger_pos);
    ob_printf(o, "\n$end\n");
    ob_printf(o, "$timescale 1 %s $end\n", unit_per_s == 1000000000ull ? "ns" : "ps");
    ob_printf(o, "$scope module webpulse $end\n");
    mask &= 0xffu;
    for (c = 0; c < 8; c++) {
        char nm[64];
        if (!(mask & (1u << c)))
            continue;
        channel_name(names, c, nm, sizeof(nm));
        ob_printf(o, "$var wire 1 %c %s $end\n", '!' + c, nm);
    }
    ob_printf(o, "$upscope $end\n$enddefinitions $end\n");

    if (s->n == 0)
        goto done;

    prev = s->raw[0];
    ob_printf(o, "#0\n$dumpvars\n");
    for (c = 0; c < 8; c++)
        if (mask & (1u << c))
            ob_printf(o, "%c%c\n", (prev >> c) & 1 ? '1' : '0', '!' + c);
    ob_printf(o, "$end\n");

    for (i = 1; i < s->n && !o->err; i++) {
        uint8_t v = s->raw[i], diff = (uint8_t)((v ^ prev) & mask);
        char line[64];
        size_t n = 0;
        uint64_t t;
        if (!diff)
            continue;
        t = (uint64_t)((unsigned __int128)i * unit_per_s / s->rate);
        line[n++] = '#';
        n += u64_dec(line + n, t);
        line[n++] = '\n';
        for (c = 0; c < 8; c++) {
            if (diff & (1u << c)) {
                line[n++] = (v >> c) & 1 ? '1' : '0';
                line[n++] = (char)('!' + c);
                line[n++] = '\n';
            }
        }
        ob_put(o, line, n);
        prev = v;
    }
    /* Final timestamp marks the end of the capture. */
    {
        char line[32];
        size_t n = 0;
        line[n++] = '#';
        n += u64_dec(line + n, (uint64_t)((unsigned __int128)s->n * unit_per_s / s->rate));
        line[n++] = '\n';
        ob_put(o, line, n);
    }
done:
    ob_flush(o);
    err = o->err;
    free(o);
    return err;
}

int wp_export_csv(const wp_store *s, const char *const *names, unsigned mask,
                  int changes_only, wp_write_fn fn, void *ctx)
{
    outbuf *o = ob_new(fn, ctx);
    uint64_t i;
    int c, err;

    if (!o)
        return -1;

    mask &= 0xffu;
    ob_printf(o, "sample,time_ns");
    for (c = 0; c < 8; c++) {
        char nm[64];
        if (!(mask & (1u << c)))
            continue;
        channel_name(names, c, nm, sizeof(nm));
        ob_printf(o, ",%s", nm);
    }
    ob_printf(o, "\n");

    for (i = 0; i < s->n && !o->err; i++) {
        uint8_t v = s->raw[i];
        char line[96];
        size_t n = 0;
        uint64_t ps;
        if (changes_only && i > 0 && i + 1 < s->n && !((v ^ s->raw[i - 1]) & mask))
            continue;
        ps = wp_sample_to_ps(i, s->rate);
        n += u64_dec(line + n, i);
        line[n++] = ',';
        n += u64_dec(line + n, ps / 1000);
        line[n++] = '.';
        line[n++] = (char)('0' + (ps / 100) % 10);
        line[n++] = (char)('0' + (ps / 10) % 10);
        line[n++] = (char)('0' + ps % 10);
        for (c = 0; c < 8; c++) {
            if (!(mask & (1u << c)))
                continue;
            line[n++] = ',';
            line[n++] = (v >> c) & 1 ? '1' : '0';
        }
        line[n++] = '\n';
        ob_put(o, line, n);
    }
    ob_flush(o);
    err = o->err;
    free(o);
    return err;
}

int wp_write_file(void *ctx, const void *data, size_t len)
{
    return fwrite(data, 1, len, (FILE *)ctx) == len ? 0 : -1;
}
