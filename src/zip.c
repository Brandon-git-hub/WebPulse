#include "zip.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- CRC-32 (IEEE, as used by ZIP) --------------------------------------------- */

static uint32_t crc_table[256];

static void crc_init(void)
{
    uint32_t i, k;
    if (crc_table[1])
        return;
    for (i = 0; i < 256; i++) {
        uint32_t c = i;
        for (k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
        crc_table[i] = c;
    }
}

uint32_t wp_crc32(uint32_t crc, const void *data, size_t len)
{
    const uint8_t *p = data;
    crc_init();
    crc = ~crc;
    while (len--)
        crc = crc_table[(crc ^ *p++) & 0xff] ^ (crc >> 8);
    return ~crc;
}

/* ---- deflate tables (RFC 1951) ---------------------------------------------------- */

static const uint16_t len_base[29] = {
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
};
static const uint8_t len_extra[29] = {
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
};
static const uint16_t dist_base[30] = {
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
};
static const uint8_t dist_extra[30] = {
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
};

/* ---- deflate: LZ77 with hash chains, one fixed-Huffman block ---------------------- */

#define WIN_SIZE   32768
#define HASH_BITS  15
#define MAX_CHAIN  32
#define MIN_MATCH  3
#define MAX_MATCH  258

typedef struct {
    uint8_t *buf;
    size_t len, cap;
    uint32_t bits;      /* pending bits, LSB first */
    int nbits;
    int oom;
} bitout;

static void put_byte(bitout *o, uint8_t b)
{
    if (o->len == o->cap) {
        size_t cap = o->cap ? o->cap * 2 : 65536;
        uint8_t *n = realloc(o->buf, cap);
        if (!n) {
            o->oom = 1;
            return;
        }
        o->buf = n;
        o->cap = cap;
    }
    o->buf[o->len++] = b;
}

static void put_bits(bitout *o, uint32_t v, int n)
{
    o->bits |= v << o->nbits;
    o->nbits += n;
    while (o->nbits >= 8) {
        put_byte(o, (uint8_t)o->bits);
        o->bits >>= 8;
        o->nbits -= 8;
    }
}

/* Huffman codes are sent most significant bit first. */
static void put_code(bitout *o, uint32_t code, int n)
{
    uint32_t r = 0;
    int i;
    for (i = 0; i < n; i++)
        r |= ((code >> i) & 1u) << (n - 1 - i);
    put_bits(o, r, n);
}

static void put_litlen(bitout *o, int sym)
{
    if (sym < 144)
        put_code(o, 0x30 + (uint32_t)sym, 8);
    else if (sym < 256)
        put_code(o, 0x190 + (uint32_t)(sym - 144), 9);
    else if (sym < 280)
        put_code(o, (uint32_t)(sym - 256), 7);
    else
        put_code(o, 0xc0 + (uint32_t)(sym - 280), 8);
}

static void put_match(bitout *o, int len, int dist)
{
    int i = 28, d = 29;
    while (len_base[i] > len)
        i--;
    put_litlen(o, 257 + i);
    if (len_extra[i])
        put_bits(o, (uint32_t)(len - len_base[i]), len_extra[i]);
    while (dist_base[d] > dist)
        d--;
    put_code(o, (uint32_t)d, 5);
    if (dist_extra[d])
        put_bits(o, (uint32_t)(dist - dist_base[d]), dist_extra[d]);
}

static uint32_t hash3(const uint8_t *p)
{
    return (((uint32_t)p[0] << 16 | (uint32_t)p[1] << 8 | p[2]) * 2654435761u) >> (32 - HASH_BITS);
}

uint8_t *wp_deflate(const uint8_t *data, size_t len, size_t *out_len)
{
    bitout o = { 0 };
    int32_t *head = malloc(sizeof(int32_t) << HASH_BITS);
    int32_t *prev = malloc(sizeof(int32_t) * WIN_SIZE);
    size_t i = 0;

    if (!head || !prev) {
        free(head);
        free(prev);
        return NULL;
    }
    memset(head, 0xff, sizeof(int32_t) << HASH_BITS);    /* -1: empty */
    put_bits(&o, 1, 1);         /* BFINAL */
    put_bits(&o, 1, 2);         /* BTYPE = 01, fixed Huffman */

    while (i < len && !o.oom) {
        int best = 0, best_dist = 0;
        if (i + MIN_MATCH <= len) {
            uint32_t h = hash3(data + i);
            int32_t cand = head[h];
            int chain = MAX_CHAIN;
            size_t maxlen = len - i < MAX_MATCH ? len - i : MAX_MATCH;
            /* A run continuing the previous byte is the common case for
             * logic data: try distance 1 first. */
            if (i > 0 && data[i - 1] == data[i]) {
                size_t l = 0;
                while (l < maxlen && data[i + l] == data[i - 1])
                    l++;
                if (l >= MIN_MATCH) {
                    best = (int)l;
                    best_dist = 1;
                }
            }
            while (cand >= 0 && chain-- > 0 && best < (int)maxlen) {
                size_t dist = i - (size_t)cand;
                size_t l = 0;
                if (dist > WIN_SIZE)
                    break;
                while (l < maxlen && data[cand + l] == data[i + l])
                    l++;
                if ((int)l > best) {
                    best = (int)l;
                    best_dist = (int)dist;
                }
                cand = prev[cand % WIN_SIZE];
            }
        }
        if (best >= MIN_MATCH) {
            size_t end = i + (size_t)best;
            put_match(&o, best, best_dist);
            /* Index the matched positions (sparsely for long runs). */
            for (; i < end; i++) {
                if (i + MIN_MATCH <= len && (end - i < 16 || (i & 7) == 0)) {
                    uint32_t h = hash3(data + i);
                    prev[i % WIN_SIZE] = head[h];
                    head[h] = (int32_t)i;
                }
            }
        } else {
            if (i + MIN_MATCH <= len) {
                uint32_t h = hash3(data + i);
                prev[i % WIN_SIZE] = head[h];
                head[h] = (int32_t)i;
            }
            put_litlen(&o, data[i]);
            i++;
        }
    }
    put_litlen(&o, 256);        /* end of block */
    if (o.nbits)
        put_bits(&o, 0, 8 - o.nbits);
    free(head);
    free(prev);
    if (o.oom) {
        free(o.buf);
        return NULL;
    }
    *out_len = o.len;
    return o.buf ? o.buf : malloc(1);
}

/* ---- inflate ---------------------------------------------------------------------- */

typedef struct {
    const uint8_t *in;
    size_t in_len, pos;
    uint32_t bits;
    int nbits;
    uint8_t *out;
    size_t out_len, out_pos;
} inflater;

/* Canonical Huffman decoding table: counts per length, symbols by code. */
typedef struct {
    uint16_t count[16];
    uint16_t sym[320];
} huff;

static int need_bits(inflater *s, int n)
{
    while (s->nbits < n) {
        if (s->pos >= s->in_len)
            return -1;
        s->bits |= (uint32_t)s->in[s->pos++] << s->nbits;
        s->nbits += 8;
    }
    return 0;
}

static int get_bits(inflater *s, int n, uint32_t *v)
{
    if (n == 0) {
        *v = 0;
        return 0;
    }
    if (need_bits(s, n) < 0)
        return -1;
    *v = s->bits & ((1u << n) - 1);
    s->bits >>= n;
    s->nbits -= n;
    return 0;
}

static int build_huff(huff *h, const uint8_t *lengths, int n)
{
    uint16_t offs[16];
    int i, left = 1;
    memset(h->count, 0, sizeof(h->count));
    for (i = 0; i < n; i++)
        h->count[lengths[i]]++;
    h->count[0] = 0;
    for (i = 1; i < 16; i++) {
        left <<= 1;
        left -= h->count[i];
        if (left < 0)
            return -1;      /* over-subscribed */
    }
    offs[1] = 0;
    for (i = 1; i < 15; i++)
        offs[i + 1] = (uint16_t)(offs[i] + h->count[i]);
    for (i = 0; i < n; i++)
        if (lengths[i])
            h->sym[offs[lengths[i]]++] = (uint16_t)i;
    return 0;
}

static int decode_sym(inflater *s, const huff *h)
{
    int code = 0, first = 0, index = 0, len;
    for (len = 1; len < 16; len++) {
        uint32_t b;
        int count = h->count[len];
        if (get_bits(s, 1, &b) < 0)
            return -1;
        code |= (int)b;
        if (code - count < first)
            return h->sym[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    return -1;
}

static int inflate_codes(inflater *s, const huff *lit, const huff *dist)
{
    for (;;) {
        int sym = decode_sym(s, lit);
        if (sym < 0)
            return -1;
        if (sym < 256) {
            if (s->out_pos >= s->out_len)
                return -1;
            s->out[s->out_pos++] = (uint8_t)sym;
        } else if (sym == 256) {
            return 0;
        } else {
            uint32_t e;
            size_t len, d;
            sym -= 257;
            if (sym >= 29 || get_bits(s, len_extra[sym], &e) < 0)
                return -1;
            len = len_base[sym] + e;
            sym = decode_sym(s, dist);
            if (sym < 0 || sym >= 30 || get_bits(s, dist_extra[sym], &e) < 0)
                return -1;
            d = dist_base[sym] + e;
            if (d > s->out_pos || len > s->out_len - s->out_pos)
                return -1;
            while (len--) {
                s->out[s->out_pos] = s->out[s->out_pos - d];
                s->out_pos++;
            }
        }
    }
}

static int inflate_fixed(inflater *s)
{
    static huff lit, dist;
    static int ready;
    if (!ready) {
        uint8_t l[288];
        int i;
        for (i = 0; i < 144; i++) l[i] = 8;
        for (; i < 256; i++) l[i] = 9;
        for (; i < 280; i++) l[i] = 7;
        for (; i < 288; i++) l[i] = 8;
        build_huff(&lit, l, 288);
        for (i = 0; i < 30; i++) l[i] = 5;
        build_huff(&dist, l, 30);
        ready = 1;
    }
    return inflate_codes(s, &lit, &dist);
}

static int inflate_dynamic(inflater *s)
{
    static const uint8_t order[19] = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 };
    uint8_t lengths[320];
    huff lencode, lit, dist;
    uint32_t hlit, hdist, hclen, v;
    int i, n;

    if (get_bits(s, 5, &hlit) < 0 || get_bits(s, 5, &hdist) < 0 || get_bits(s, 4, &hclen) < 0)
        return -1;
    hlit += 257;
    hdist += 1;
    hclen += 4;
    if (hlit > 286 || hdist > 30)
        return -1;
    memset(lengths, 0, 19);
    for (i = 0; i < (int)hclen; i++) {
        if (get_bits(s, 3, &v) < 0)
            return -1;
        lengths[order[i]] = (uint8_t)v;
    }
    if (build_huff(&lencode, lengths, 19) < 0)
        return -1;
    n = (int)(hlit + hdist);
    for (i = 0; i < n;) {
        int sym = decode_sym(s, &lencode), rep;
        uint8_t val = 0;
        if (sym < 0)
            return -1;
        if (sym < 16) {
            lengths[i++] = (uint8_t)sym;
            continue;
        }
        if (sym == 16) {
            if (i == 0 || get_bits(s, 2, &v) < 0)
                return -1;
            val = lengths[i - 1];
            rep = 3 + (int)v;
        } else if (sym == 17) {
            if (get_bits(s, 3, &v) < 0)
                return -1;
            rep = 3 + (int)v;
        } else {
            if (get_bits(s, 7, &v) < 0)
                return -1;
            rep = 11 + (int)v;
        }
        if (i + rep > n)
            return -1;
        while (rep--)
            lengths[i++] = val;
    }
    if (lengths[256] == 0 || build_huff(&lit, lengths, (int)hlit) < 0 ||
        build_huff(&dist, lengths + hlit, (int)hdist) < 0)
        return -1;
    return inflate_codes(s, &lit, &dist);
}

int wp_inflate(const uint8_t *in, size_t in_len, uint8_t *out, size_t out_len)
{
    inflater s = { in, in_len, 0, 0, 0, out, out_len, 0 };
    uint32_t last, type;

    do {
        if (get_bits(&s, 1, &last) < 0 || get_bits(&s, 2, &type) < 0)
            return -1;
        if (type == 0) {
            uint16_t len, nlen;
            s.bits = 0;             /* skip to a byte boundary */
            s.nbits = 0;
            if (s.pos + 4 > in_len)
                return -1;
            len = (uint16_t)(in[s.pos] | in[s.pos + 1] << 8);
            nlen = (uint16_t)(in[s.pos + 2] | in[s.pos + 3] << 8);
            s.pos += 4;
            if ((uint16_t)~nlen != len || s.pos + len > in_len || len > out_len - s.out_pos)
                return -1;
            memcpy(out + s.out_pos, in + s.pos, len);
            s.pos += len;
            s.out_pos += len;
        } else if (type == 1) {
            if (inflate_fixed(&s) < 0)
                return -1;
        } else if (type == 2) {
            if (inflate_dynamic(&s) < 0)
                return -1;
        } else {
            return -1;
        }
    } while (!last);
    return s.out_pos == out_len ? 0 : -1;
}

/* ---- ZIP writer ----------------------------------------------------------------------- */

#define ZIP_TIME 0x0000     /* 00:00:00 */
#define ZIP_DATE 0x5a21     /* 2025-01-01; sigrok does not use the date */

typedef struct {
    char name[64];
    uint32_t crc, csize, usize, offset;
    uint16_t method;
} zent;

struct wp_zip_writer {
    wp_write_fn fn;
    void *ctx;
    uint64_t offset;
    zent *e;
    size_t n, cap;
    int err;
};

static void le16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void le32(uint8_t *p, uint32_t v) { le16(p, (uint16_t)v); le16(p + 2, (uint16_t)(v >> 16)); }
static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t rd32(const uint8_t *p) { return (uint32_t)rd16(p) | (uint32_t)rd16(p + 2) << 16; }

static void zwrite(wp_zip_writer *z, const void *d, size_t len)
{
    if (z->err || !len)
        return;
    if (z->fn(z->ctx, d, len) != 0)
        z->err = 1;
    z->offset += len;
}

wp_zip_writer *wp_zip_writer_new(wp_write_fn fn, void *ctx)
{
    wp_zip_writer *z = calloc(1, sizeof(*z));
    if (z) {
        z->fn = fn;
        z->ctx = ctx;
    }
    return z;
}

int wp_zip_add(wp_zip_writer *z, const char *name, const void *data, size_t len)
{
    uint8_t h[30];
    size_t nlen = strlen(name), clen = len;
    uint8_t *comp = NULL;
    zent *e;

    if (z->err || nlen >= sizeof(e->name) || len > 0xffffffffu || z->offset > 0xffffffffu) {
        z->err = 1;
        return -1;
    }
    if (z->n == z->cap) {
        size_t cap = z->cap ? z->cap * 2 : 64;
        zent *ne = realloc(z->e, cap * sizeof(*ne));
        if (!ne) {
            z->err = 1;
            return -1;
        }
        z->e = ne;
        z->cap = cap;
    }
    e = &z->e[z->n];
    memcpy(e->name, name, nlen + 1);
    e->crc = wp_crc32(0, data, len);
    e->usize = (uint32_t)len;
    e->offset = (uint32_t)z->offset;
    e->method = 0;
    if (len > 64) {
        comp = wp_deflate(data, len, &clen);
        if (comp && clen < len)
            e->method = 8;
        else
            clen = len;
    }
    e->csize = (uint32_t)clen;

    le32(h, 0x04034b50);
    le16(h + 4, 20);                /* version needed: 2.0 (deflate) */
    le16(h + 6, 0);                 /* flags */
    le16(h + 8, e->method);
    le16(h + 10, ZIP_TIME);
    le16(h + 12, ZIP_DATE);
    le32(h + 14, e->crc);
    le32(h + 18, e->csize);
    le32(h + 22, e->usize);
    le16(h + 26, (uint16_t)nlen);
    le16(h + 28, 0);
    zwrite(z, h, sizeof(h));
    zwrite(z, name, nlen);
    zwrite(z, e->method == 8 ? comp : data, clen);
    free(comp);
    z->n++;
    return z->err ? -1 : 0;
}

int wp_zip_finish(wp_zip_writer *z)
{
    uint8_t h[46], end[22];
    uint64_t cd_start = z->offset;
    size_t i;
    int err;

    for (i = 0; i < z->n; i++) {
        const zent *e = &z->e[i];
        size_t nlen = strlen(e->name);
        le32(h, 0x02014b50);
        le16(h + 4, 20);            /* made by: MS-DOS / FAT, 2.0 */
        le16(h + 6, 20);
        le16(h + 8, 0);
        le16(h + 10, e->method);
        le16(h + 12, ZIP_TIME);
        le16(h + 14, ZIP_DATE);
        le32(h + 16, e->crc);
        le32(h + 20, e->csize);
        le32(h + 24, e->usize);
        le16(h + 28, (uint16_t)nlen);
        le16(h + 30, 0);            /* extra */
        le16(h + 32, 0);            /* comment */
        le16(h + 34, 0);            /* disk */
        le16(h + 36, 0);            /* internal attributes */
        le32(h + 38, 0);            /* external attributes */
        le32(h + 42, e->offset);
        zwrite(z, h, sizeof(h));
        zwrite(z, e->name, nlen);
    }
    if (z->offset > 0xffffffffu || z->n > 0xffff)
        z->err = 1;
    le32(end, 0x06054b50);
    le16(end + 4, 0);
    le16(end + 6, 0);
    le16(end + 8, (uint16_t)z->n);
    le16(end + 10, (uint16_t)z->n);
    le32(end + 12, (uint32_t)(z->offset - cd_start));
    le32(end + 16, (uint32_t)cd_start);
    le16(end + 20, 0);
    zwrite(z, end, sizeof(end));
    err = z->err;
    free(z->e);
    free(z);
    return err ? -1 : 0;
}

/* ---- ZIP reader ------------------------------------------------------------------------ */

int wp_zip_open(const uint8_t *buf, size_t len, wp_zip_dir *dir, char *err, size_t errlen)
{
    size_t eocd, p, i, count;
    uint32_t cd_off, cd_size;

    memset(dir, 0, sizeof(*dir));
    if (len < 22) {
        snprintf(err, errlen, "not a ZIP file (too short)");
        return -1;
    }
    /* End of central directory: last 22 bytes plus up to 64 KiB of comment. */
    for (eocd = len - 22;; eocd--) {
        if (rd32(buf + eocd) == 0x06054b50)
            break;
        if (eocd == 0 || len - eocd > 22 + 65535) {
            snprintf(err, errlen, "not a ZIP file");
            return -1;
        }
    }
    count = rd16(buf + eocd + 10);
    cd_size = rd32(buf + eocd + 12);
    cd_off = rd32(buf + eocd + 16);
    if (cd_off == 0xffffffffu || count == 0xffff) {
        snprintf(err, errlen, "ZIP64 archives are not supported");
        return -1;
    }
    if ((uint64_t)cd_off + cd_size > eocd) {
        snprintf(err, errlen, "corrupt ZIP central directory");
        return -1;
    }
    dir->e = calloc(count ? count : 1, sizeof(*dir->e));
    if (!dir->e) {
        snprintf(err, errlen, "out of memory");
        return -1;
    }
    for (p = cd_off, i = 0; i < count; i++) {
        wp_zip_entry *e = &dir->e[i];
        uint32_t loff;
        size_t nlen, xlen, clen, data;
        if (p + 46 > eocd || rd32(buf + p) != 0x02014b50)
            goto corrupt;
        e->method = rd16(buf + p + 10);
        e->crc = rd32(buf + p + 16);
        e->csize = rd32(buf + p + 20);
        e->usize = rd32(buf + p + 24);
        nlen = rd16(buf + p + 28);
        xlen = rd16(buf + p + 30);
        clen = rd16(buf + p + 32);
        loff = rd32(buf + p + 42);
        if (p + 46 + nlen > eocd || nlen >= sizeof(e->name))
            goto corrupt;
        memcpy(e->name, buf + p + 46, nlen);
        e->name[nlen] = '\0';
        p += 46 + nlen + xlen + clen;
        /* The data follows the local header, whose name / extra lengths may
         * differ from the central directory's. */
        if ((uint64_t)loff + 30 > len || rd32(buf + loff) != 0x04034b50)
            goto corrupt;
        data = loff + 30 + rd16(buf + loff + 26) + rd16(buf + loff + 28);
        if (data + e->csize > len)
            goto corrupt;
        e->data = buf + data;
        dir->n++;
    }
    return 0;
corrupt:
    snprintf(err, errlen, "corrupt ZIP file");
    wp_zip_close(dir);
    return -1;
}

void wp_zip_close(wp_zip_dir *dir)
{
    free(dir->e);
    dir->e = NULL;
    dir->n = 0;
}

const wp_zip_entry *wp_zip_find(const wp_zip_dir *dir, const char *name)
{
    size_t i;
    for (i = 0; i < dir->n; i++)
        if (strcmp(dir->e[i].name, name) == 0)
            return &dir->e[i];
    return NULL;
}

uint8_t *wp_zip_read(const wp_zip_entry *e, char *err, size_t errlen)
{
    uint8_t *out = malloc((size_t)e->usize + 1);
    if (!out) {
        snprintf(err, errlen, "out of memory for %s (%u bytes)", e->name, e->usize);
        return NULL;
    }
    if (e->method == 0) {
        if (e->csize != e->usize)
            goto bad;
        memcpy(out, e->data, e->usize);
    } else if (e->method == 8) {
        if (wp_inflate(e->data, e->csize, out, e->usize) != 0)
            goto bad;
    } else {
        snprintf(err, errlen, "%s: unsupported compression method %u", e->name, e->method);
        free(out);
        return NULL;
    }
    if (wp_crc32(0, out, e->usize) != e->crc)
        goto bad;
    out[e->usize] = '\0';
    return out;
bad:
    snprintf(err, errlen, "%s: corrupt data", e->name);
    free(out);
    return NULL;
}
