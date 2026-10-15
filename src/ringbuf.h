/*
 * Lock-free single-producer / single-consumer byte ring buffer.
 * Producer: the device backend (USB callback / sim thread).
 * Consumer: the capture engine's processing thread.
 */
#ifndef WP_RINGBUF_H
#define WP_RINGBUF_H

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t *buf;
    size_t cap;                 /* power of two */
    _Atomic size_t head;        /* total bytes written */
    _Atomic size_t tail;        /* total bytes consumed */
} wp_ringbuf;

/* cap is rounded up to a power of two. Returns 0 on success. */
int wp_ringbuf_init(wp_ringbuf *rb, size_t cap);
void wp_ringbuf_free(wp_ringbuf *rb);

/* Producer: copies up to len bytes; returns bytes written (< len when full). */
size_t wp_ringbuf_write(wp_ringbuf *rb, const void *data, size_t len);

/* Consumer: returns length of the contiguous readable region at *p. */
size_t wp_ringbuf_peek(wp_ringbuf *rb, const uint8_t **p);
void wp_ringbuf_consume(wp_ringbuf *rb, size_t len);

size_t wp_ringbuf_used(wp_ringbuf *rb);

#endif
