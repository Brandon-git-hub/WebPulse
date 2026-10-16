#include "capture_store.h"

#include <stdlib.h>
#include <string.h>

static int build_level(wp_store_level *dst, const uint8_t *src_pairs, const uint8_t *raw,
                       uint64_t src_n, uint64_t block)
{
    uint64_t i, nb = (src_n + WP_STORE_FANOUT - 1) / WP_STORE_FANOUT;

    dst->d = malloc(nb * 2);
    if (!dst->d)
        return -1;
    dst->n = nb;
    dst->block = block;

    for (i = 0; i < nb; i++) {
        uint64_t j = i * WP_STORE_FANOUT;
        uint64_t end = j + WP_STORE_FANOUT;
        uint8_t o = 0, a = 0xff;
        if (end > src_n)
            end = src_n;
        if (raw) {
            for (; j < end; j++) {
                o |= raw[j];
                a &= raw[j];
            }
        } else {
            for (; j < end; j++) {
                o |= src_pairs[2 * j];
                a &= src_pairs[2 * j + 1];
            }
        }
        dst->d[2 * i] = o;
        dst->d[2 * i + 1] = a;
    }
    return 0;
}

wp_store *wp_store_new(uint8_t *raw, uint64_t n, uint64_t rate, int64_t trigger_pos)
{
    wp_store *s = calloc(1, sizeof(*s));
    uint64_t block = WP_STORE_FANOUT;
    uint64_t src_n = n;

    if (!s) {
        free(raw);
        return NULL;
    }
    atomic_init(&s->refs, 1);
    s->raw = raw;
    s->n = n;
    s->rate = rate;
    s->trigger_pos = trigger_pos;

    /* Build levels until a level has a single block. */
    while (src_n > 1 && s->nlevels < WP_STORE_MAX_LEVELS) {
        wp_store_level *lv = &s->lv[s->nlevels];
        const uint8_t *src = s->nlevels ? s->lv[s->nlevels - 1].d : NULL;
        if (build_level(lv, src, s->nlevels ? NULL : raw, src_n, block) < 0) {
            wp_store_unref(s);
            return NULL;
        }
        src_n = lv->n;
        block *= WP_STORE_FANOUT;
        s->nlevels++;
    }
    if (n > 0) {
        uint8_t o, a;
        wp_store_range(s, 0, n, &o, &a);
        s->changing = (uint8_t)(o & ~a);
    }
    return s;
}

void wp_store_ref(wp_store *s)
{
    atomic_fetch_add(&s->refs, 1);
}

void wp_store_unref(wp_store *s)
{
    int i;
    if (!s || atomic_fetch_sub(&s->refs, 1) != 1)
        return;
    for (i = 0; i < s->nlevels; i++)
        free(s->lv[i].d);
    free(s->raw);
    free(s);
}

static void acc(const wp_store *s, uint64_t a, uint64_t b, int L, uint8_t *o, uint8_t *an)
{
    uint64_t first, last, j, B;

    while (a < b) {
        if (L < 0) {
            for (; a < b; a++) {
                *o |= s->raw[a];
                *an &= s->raw[a];
            }
            return;
        }
        B = s->lv[L].block;
        first = (a + B - 1) / B;
        last = b / B;
        if (first >= last) {
            L--;
            continue;
        }
        acc(s, a, first * B, L - 1, o, an);
        for (j = first; j < last; j++) {
            *o |= s->lv[L].d[2 * j];
            *an &= s->lv[L].d[2 * j + 1];
        }
        a = last * B;
        L--;
    }
}

void wp_store_range(const wp_store *s, uint64_t a, uint64_t b,
                    uint8_t *or_out, uint8_t *and_out)
{
    int L = s->nlevels - 1;
    uint8_t o = 0, an = 0xff;

    while (L >= 0 && s->lv[L].block > b - a)
        L--;
    acc(s, a, b, L, &o, &an);
    *or_out = o;
    *and_out = an;
}

/* Does block idx of level k contain a sample whose bit differs from level L? */
static int block_differs(const wp_store *s, int k, uint64_t idx, uint8_t bit, int L)
{
    const uint8_t *p = s->lv[k].d + 2 * idx;
    return L ? !(p[1] & bit) : (p[0] & bit) != 0;
}

/* Is every sample of block idx of level k equal to v on the mask bits? */
static int block_equals(const wp_store *s, int k, uint64_t idx, uint8_t mask, uint8_t v)
{
    const uint8_t *p = s->lv[k].d + 2 * idx;
    return (p[0] & mask) == (v & mask) && (p[1] & mask) == (v & mask);
}

int64_t wp_store_next_change(const wp_store *s, uint8_t mask, uint64_t from)
{
    uint8_t v;
    uint64_t pos;

    if (from + 1 >= s->n || !mask)
        return -1;
    v = s->raw[from];
    pos = from + 1;
    while (pos < s->n) {
        int k = s->nlevels - 1;
        /* Largest block starting at pos, then descend while it has a change. */
        while (k >= 0 && pos % s->lv[k].block)
            k--;
        while (k >= 0 && !block_equals(s, k, pos / s->lv[k].block, mask, v))
            k--;
        if (k >= 0) {
            pos += s->lv[k].block;      /* whole block is unchanged */
            continue;
        }
        if ((s->raw[pos] ^ v) & mask)
            return (int64_t)pos;
        pos++;
    }
    return -1;
}

int64_t wp_store_next_edge(const wp_store *s, int ch, uint64_t from)
{
    return wp_store_next_change(s, (uint8_t)(1u << ch), from);
}

int64_t wp_store_prev_edge(const wp_store *s, int ch, uint64_t from)
{
    const uint8_t bit = (uint8_t)(1u << ch);
    uint64_t end;           /* search samples < end for one that differs */
    int L;

    if (from >= s->n)
        return -1;
    L = (s->raw[from] & bit) != 0;
    end = from;
    while (end > 0) {
        int k = s->nlevels - 1;
        /* Largest block ending at end-1 (the last block may be partial only
         * at the end of the capture, which is never below from). */
        while (k >= 0 && end % s->lv[k].block)
            k--;
        while (k >= 0 && block_differs(s, k, end / s->lv[k].block - 1, bit, L))
            k--;
        if (k >= 0) {
            end -= s->lv[k].block;
            continue;
        }
        if (((s->raw[end - 1] & bit) != 0) != L)
            return (int64_t)end;
        end--;
    }
    return -1;
}

size_t wp_store_query_max(uint32_t width)
{
    /* raw: at most width samples; summary: 2 bytes per pixel */
    return (size_t)width * 2;
}

size_t wp_store_query(const wp_store *s, uint64_t t0, uint64_t t1, uint32_t width,
                      uint8_t *out, size_t outcap, uint8_t *mode, uint64_t *t1_out)
{
    uint64_t span, p;

    if (t1 > s->n)
        t1 = s->n;
    if (t0 > t1)
        t0 = t1;
    *t1_out = t1;
    span = t1 - t0;

    if (width == 0 || span <= width) {
        if (span > outcap)
            span = outcap;
        *mode = WP_QUERY_RAW;
        memcpy(out, s->raw + t0, (size_t)span);
        *t1_out = t0 + span;
        return (size_t)span;
    }

    *mode = WP_QUERY_SUMMARY;
    if ((size_t)width * 2 > outcap)
        width = (uint32_t)(outcap / 2);
    for (p = 0; p < width; p++) {
        uint64_t a = t0 + (uint64_t)((unsigned __int128)span * p / width);
        uint64_t b = t0 + (uint64_t)((unsigned __int128)span * (p + 1) / width);
        uint8_t o, an;
        uint16_t v = 0;
        int c;
        wp_store_range(s, a, b, &o, &an);
        for (c = 0; c < 8; c++) {
            v |= (uint16_t)(((o >> c) & 1u) << (2 * c));
            v |= (uint16_t)((((an >> c) & 1u) ^ 1u) << (2 * c + 1));
        }
        out[2 * p] = (uint8_t)(v & 0xff);
        out[2 * p + 1] = (uint8_t)(v >> 8);
    }
    return (size_t)width * 2;
}
