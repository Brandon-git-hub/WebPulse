#include "ringbuf.h"

#include <stdlib.h>
#include <string.h>

int wp_ringbuf_init(wp_ringbuf *rb, size_t cap)
{
    size_t c = 1;
    while (c < cap)
        c <<= 1;
    rb->buf = malloc(c);
    if (!rb->buf)
        return -1;
    rb->cap = c;
    atomic_init(&rb->head, 0);
    atomic_init(&rb->tail, 0);
    return 0;
}

void wp_ringbuf_free(wp_ringbuf *rb)
{
    free(rb->buf);
    rb->buf = NULL;
    rb->cap = 0;
}

size_t wp_ringbuf_write(wp_ringbuf *rb, const void *data, size_t len)
{
    size_t head = atomic_load_explicit(&rb->head, memory_order_relaxed);
    size_t tail = atomic_load_explicit(&rb->tail, memory_order_acquire);
    size_t space = rb->cap - (head - tail);
    size_t off, first;

    if (len > space)
        len = space;
    if (len == 0)
        return 0;
    off = head & (rb->cap - 1);
    first = rb->cap - off;
    if (first > len)
        first = len;
    memcpy(rb->buf + off, data, first);
    memcpy(rb->buf, (const uint8_t *)data + first, len - first);
    atomic_store_explicit(&rb->head, head + len, memory_order_release);
    return len;
}

size_t wp_ringbuf_peek(wp_ringbuf *rb, const uint8_t **p)
{
    size_t tail = atomic_load_explicit(&rb->tail, memory_order_relaxed);
    size_t head = atomic_load_explicit(&rb->head, memory_order_acquire);
    size_t used = head - tail;
    size_t off = tail & (rb->cap - 1);
    size_t contig = rb->cap - off;

    *p = rb->buf + off;
    return used < contig ? used : contig;
}

void wp_ringbuf_consume(wp_ringbuf *rb, size_t len)
{
    size_t tail = atomic_load_explicit(&rb->tail, memory_order_relaxed);
    atomic_store_explicit(&rb->tail, tail + len, memory_order_release);
}

size_t wp_ringbuf_used(wp_ringbuf *rb)
{
    return atomic_load_explicit(&rb->head, memory_order_acquire) -
           atomic_load_explicit(&rb->tail, memory_order_acquire);
}
