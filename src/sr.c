#include "sr.h"
#include "util.h"
#include "zip.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SR_CHUNK (4u << 20)     /* bytes per logic-1-N member */
#define MAX_MEMBERS 65536

/* "24 MHz", "250 kHz", "100 Hz", as libsigrok's sr_samplerate_string(). */
static void rate_string(uint64_t rate, char *out, size_t len)
{
    if (rate >= 1000000000ull && rate % 1000000000ull == 0)
        snprintf(out, len, "%llu GHz", (unsigned long long)(rate / 1000000000ull));
    else if (rate >= 1000000ull && rate % 1000000ull == 0)
        snprintf(out, len, "%llu MHz", (unsigned long long)(rate / 1000000ull));
    else if (rate >= 1000ull && rate % 1000ull == 0)
        snprintf(out, len, "%llu kHz", (unsigned long long)(rate / 1000ull));
    else
        snprintf(out, len, "%llu Hz", (unsigned long long)rate);
}

int wp_sr_write(const wp_store *s, const char *const *names, unsigned mask,
                wp_write_fn fn, void *ctx)
{
    wp_zip_writer *z = wp_zip_writer_new(fn, ctx);
    char meta[2048], rate[32], extra[64];
    size_t n = 0;
    uint64_t off;
    unsigned k = 1;
    int c;

    if (!z)
        return -1;
    rate_string(s->rate, rate, sizeof(rate));
    n += (size_t)snprintf(meta + n, sizeof(meta) - n,
                          "[global]\nsigrok version=0.5.2\n\n"
                          "[device 1]\ncapturefile=logic-1\ntotal probes=8\nsamplerate=%s\n"
                          "total analog=0\n", rate);
    for (c = 0; c < 8; c++) {
        char nm[64];
        if (!(mask & (1u << c)))
            continue;
        if (names && names[c] && names[c][0])
            wp_strlcpy(nm, names[c], sizeof(nm));
        else
            snprintf(nm, sizeof(nm), "CH%d", c);
        /* One line per probe: keep the name on it. */
        for (char *p = nm; *p; p++)
            if (*p == '\n' || *p == '\r' || *p == '=')
                *p = '_';
        n += (size_t)snprintf(meta + n, sizeof(meta) - n, "probe%d=%s\n", c + 1, nm);
    }
    snprintf(meta + n, sizeof(meta) - n, "unitsize=1\n");

    wp_zip_add(z, "version", "2", 1);
    wp_zip_add(z, "metadata", meta, strlen(meta));
    for (off = 0; off < s->n; off += SR_CHUNK, k++) {
        char name[32];
        size_t len = s->n - off < SR_CHUNK ? (size_t)(s->n - off) : SR_CHUNK;
        snprintf(name, sizeof(name), "logic-1-%u", k);
        if (wp_zip_add(z, name, s->raw + off, len) != 0)
            break;
    }
    snprintf(extra, sizeof(extra), "trigger_pos=%lld\n", (long long)s->trigger_pos);
    wp_zip_add(z, "webpulse", extra, strlen(extra));
    return wp_zip_finish(z);
}

/* ---- reading ----------------------------------------------------------------------------- */

static char *trim(char *s)
{
    char *e;
    while (isspace((unsigned char)*s))
        s++;
    e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1]))
        *--e = '\0';
    return s;
}

/* "24 MHz", "24MHz", "1.5 kHz", "1000000" -> Hz; 0 if invalid. */
static uint64_t parse_rate(const char *s)
{
    char *end;
    double v = strtod(s, &end);
    while (*end == ' ')
        end++;
    switch (*end) {
    case 'G': case 'g': v *= 1e9; break;
    case 'M': v *= 1e6; break;
    case 'k': case 'K': v *= 1e3; break;
    default: break;
    }
    return v >= 1 && v < 1e13 ? (uint64_t)(v + 0.5) : 0;
}

typedef struct {
    char capturefile[64];
    uint64_t rate;
    unsigned unitsize;
    int total_probes;
    char names[64][32];     /* by probe index 0.. */
} sr_meta;

/* Only the first device section matters: WebPulse has one logic device. */
static int parse_meta(char *text, sr_meta *m, char *err, size_t errlen)
{
    char *line = text, *next;
    int in_dev = 0, seen_dev = 0;

    memset(m, 0, sizeof(*m));
    m->unitsize = 1;
    for (; line; line = next) {
        char *l, *eq, *k, *v;
        next = strchr(line, '\n');
        if (next)
            *next++ = '\0';
        l = trim(line);
        if (!*l || *l == ';' || *l == '#')
            continue;
        if (*l == '[') {
            in_dev = !seen_dev && strncmp(l, "[device ", 8) == 0;
            seen_dev |= in_dev;
            continue;
        }
        if (!in_dev || !(eq = strchr(l, '=')))
            continue;
        *eq = '\0';
        k = trim(l);
        v = trim(eq + 1);
        if (strcmp(k, "capturefile") == 0)
            wp_strlcpy(m->capturefile, v, sizeof(m->capturefile));
        else if (strcmp(k, "samplerate") == 0)
            m->rate = parse_rate(v);
        else if (strcmp(k, "unitsize") == 0)
            m->unitsize = (unsigned)atoi(v);
        else if (strcmp(k, "total probes") == 0)
            m->total_probes = atoi(v);
        else if (strncmp(k, "probe", 5) == 0 && isdigit((unsigned char)k[5])) {
            int i = atoi(k + 5) - 1;
            if (i >= 0 && i < 64)
                wp_strlcpy(m->names[i], v, sizeof(m->names[i]));
        }
    }
    if (!seen_dev) {
        snprintf(err, errlen, "metadata has no [device] section");
        return -1;
    }
    if (!m->capturefile[0]) {
        snprintf(err, errlen, "the session has no logic data (only analog channels?)");
        return -1;
    }
    if (!m->rate) {
        snprintf(err, errlen, "metadata has no valid samplerate");
        return -1;
    }
    if (m->unitsize < 1 || m->unitsize > 8) {
        snprintf(err, errlen, "unsupported unitsize %u", m->unitsize);
        return -1;
    }
    return 0;
}

int wp_sr_read(const uint8_t *buf, size_t len, uint64_t max_samples, wp_sr_capture *out,
               char *err, size_t errlen)
{
    wp_zip_dir dir;
    const wp_zip_entry *e;
    uint8_t *text = NULL, *raw = NULL;
    sr_meta *m = NULL;
    const wp_zip_entry **members = NULL;
    size_t nmembers = 0;
    uint64_t total = 0, n = 0;
    unsigned k;
    int rc = -1, c;

    memset(out, 0, sizeof(*out));
    out->trigger_pos = -1;
    if (wp_zip_open(buf, len, &dir, err, errlen) < 0)
        return -1;
    if (!(e = wp_zip_find(&dir, "version"))) {
        snprintf(err, errlen, "not a sigrok session file (no \"version\")");
        goto out;
    }
    if (!(text = wp_zip_read(e, err, errlen)))
        goto out;
    if (atoi((char *)text) != 2) {
        snprintf(err, errlen, "unsupported session file version \"%.8s\" (need 2)", (char *)text);
        goto out;
    }
    free(text);
    if (!(e = wp_zip_find(&dir, "metadata")) || !(text = wp_zip_read(e, err, errlen))) {
        if (!e)
            snprintf(err, errlen, "session file has no metadata");
        goto out;
    }
    m = malloc(sizeof(*m));
    members = malloc(MAX_MEMBERS * sizeof(*members));
    if (!m || !members) {
        snprintf(err, errlen, "out of memory");
        goto out;
    }
    if (parse_meta((char *)text, m, err, errlen) < 0)
        goto out;

    /* Data: <capturefile>-1, -2, ... in order, or one member named <capturefile>. */
    {
        char name[96];
        size_t nm = 0;
        for (k = 1;; k++) {
            snprintf(name, sizeof(name), "%s-%u", m->capturefile, k);
            if (!(e = wp_zip_find(&dir, name)))
                break;
            if (nm < MAX_MEMBERS)
                members[nm++] = e;
            total += e->usize;
        }
        if (nm == 0 && (e = wp_zip_find(&dir, m->capturefile))) {
            members[nm++] = e;
            total = e->usize;
        }
        if (k - 1 > MAX_MEMBERS) {
            snprintf(err, errlen, "session file has too many data members");
            goto out;
        }
        nmembers = nm;
    }
    if (total == 0) {
        snprintf(err, errlen, "session file has no samples");
        goto out;
    }
    n = total / m->unitsize;
    if (n > max_samples) {
        snprintf(err, errlen, "%llu samples is more than the limit of %llu (see --max-samples)",
                 (unsigned long long)n, (unsigned long long)max_samples);
        goto out;
    }
    raw = malloc((size_t)n);
    if (!raw) {
        snprintf(err, errlen, "out of memory for %llu samples", (unsigned long long)n);
        goto out;
    }
    {
        uint64_t pos = 0;           /* sample index */
        unsigned carry = 0;         /* bytes of a unit seen so far (units may span members) */
        uint8_t first = 0;
        size_t mi, i;
        for (mi = 0; mi < nmembers; mi++) {
            uint8_t *d = wp_zip_read(members[mi], err, errlen);
            if (!d)
                goto out;
            /* Keep the low byte of each unit (channels 0..7). */
            for (i = 0; i < members[mi]->usize && pos < n; i++) {
                if (carry == 0)
                    first = d[i];
                if (++carry == m->unitsize) {
                    raw[pos++] = first;
                    carry = 0;
                }
            }
            free(d);
        }
    }

    if ((e = wp_zip_find(&dir, "webpulse"))) {
        uint8_t *x = wp_zip_read(e, err, errlen);
        const char *p = x ? strstr((char *)x, "trigger_pos=") : NULL;
        if (p) {
            long long t = atoll(p + 12);
            out->trigger_pos = t >= 0 && (uint64_t)t < n ? t : -1;
        }
        free(x);
    }
    for (c = 0; c < 8; c++) {
        if (m->names[c][0]) {
            wp_strlcpy(out->names[c], m->names[c], sizeof(out->names[c]));
            out->mask |= 1u << c;
        }
    }
    if (m->unitsize > 1 || m->total_probes > 8)
        snprintf(out->note, sizeof(out->note), "only the first 8 of %d channels were loaded",
                 m->total_probes > 8 ? m->total_probes : (int)m->unitsize * 8);
    out->raw = raw;
    out->n = n;
    out->rate = m->rate;
    raw = NULL;
    rc = 0;
out:
    free(raw);
    free(text);
    free(m);
    free(members);
    wp_zip_close(&dir);
    return rc;
}
