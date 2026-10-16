/*
 * Minimal ZIP support for sigrok session files (.sr): CRC-32, raw deflate
 * (LZ77 + fixed Huffman codes, which suits logic data with its long runs),
 * inflate (stored, fixed and dynamic blocks, i.e. anything zlib writes), a
 * streaming archive writer and an in-memory archive reader. No ZIP64, so an
 * archive must stay below 4 GiB.
 */
#ifndef WP_ZIP_H
#define WP_ZIP_H

#include <stddef.h>
#include <stdint.h>

#include "export.h"     /* wp_write_fn */

uint32_t wp_crc32(uint32_t crc, const void *data, size_t len);

/* Compress len bytes into a malloc'd raw deflate stream; NULL on failure. */
uint8_t *wp_deflate(const uint8_t *data, size_t len, size_t *out_len);

/* Decompress a raw deflate stream into out (exactly out_len bytes expected).
 * Returns 0 on success. */
int wp_inflate(const uint8_t *in, size_t in_len, uint8_t *out, size_t out_len);

/* ---- writer ---------------------------------------------------------------- */

typedef struct wp_zip_writer wp_zip_writer;

wp_zip_writer *wp_zip_writer_new(wp_write_fn fn, void *ctx);
/* Add a file; it is stored deflated unless that would not make it smaller. */
int wp_zip_add(wp_zip_writer *z, const char *name, const void *data, size_t len);
/* Write the central directory and free the writer. Returns 0 on success
 * (including every earlier write). */
int wp_zip_finish(wp_zip_writer *z);

/* ---- reader ---------------------------------------------------------------- */

typedef struct {
    char name[256];
    uint16_t method;        /* 0 stored, 8 deflate */
    uint32_t crc;
    uint32_t csize, usize;
    const uint8_t *data;    /* compressed data inside the archive buffer */
} wp_zip_entry;

typedef struct {
    wp_zip_entry *e;
    size_t n;
} wp_zip_dir;

/* Parse the central directory of an archive held in memory. The entries
 * point into buf, which must outlive them. Returns 0 or -1 (err is set). */
int wp_zip_open(const uint8_t *buf, size_t len, wp_zip_dir *dir, char *err, size_t errlen);
void wp_zip_close(wp_zip_dir *dir);
const wp_zip_entry *wp_zip_find(const wp_zip_dir *dir, const char *name);
/* Decompress an entry into a malloc'd buffer (NUL-terminated for text use;
 * the NUL is not counted). NULL on error (CRC mismatch, bad data). */
uint8_t *wp_zip_read(const wp_zip_entry *e, char *err, size_t errlen);

#endif
