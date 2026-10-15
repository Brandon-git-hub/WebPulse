#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int wp_parse_si(const char *s, uint64_t *out)
{
    char *end;
    double v, mul = 1.0;

    if (!s || !*s)
        return -1;
    v = strtod(s, &end);
    if (end == s || v < 0)
        return -1;
    switch (*end) {
    case 'k': case 'K': mul = 1e3; end++; break;
    case 'M':           mul = 1e6; end++; break;
    case 'G': case 'g': mul = 1e9; end++; break;
    default: break;
    }
    /* Allow an optional unit like "Hz" or "S" after the multiplier. */
    if (*end && strcmp(end, "Hz") != 0 && strcmp(end, "hz") != 0 &&
        strcmp(end, "S") != 0 && strcmp(end, "s") != 0)
        return -1;
    v *= mul;
    if (v > 1.8e19)
        return -1;
    *out = (uint64_t)(v + 0.5);
    return 0;
}

void wp_format_rate(uint64_t rate, char *buf, size_t len)
{
    if (rate >= 1000000 && rate % 1000000 == 0)
        snprintf(buf, len, "%llu MHz", (unsigned long long)(rate / 1000000));
    else if (rate >= 1000 && rate % 1000 == 0)
        snprintf(buf, len, "%llu kHz", (unsigned long long)(rate / 1000));
    else
        snprintf(buf, len, "%llu Hz", (unsigned long long)rate);
}

uint64_t wp_sample_to_ps(uint64_t i, uint64_t rate)
{
    return (uint64_t)((unsigned __int128)i * 1000000000000ull / rate);
}

uint64_t wp_ps_to_sample_ceil(uint64_t t_ps, uint64_t rate)
{
    unsigned __int128 num = (unsigned __int128)t_ps * rate;
    return (uint64_t)((num + 999999999999ull) / 1000000000000ull);
}

void wp_strlcpy(char *dst, const char *src, size_t dstlen)
{
    size_t n;
    if (dstlen == 0)
        return;
    n = strlen(src);
    if (n >= dstlen)
        n = dstlen - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}
