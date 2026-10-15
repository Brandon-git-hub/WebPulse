/*
 * Simulated logic analyzer. Each channel is a deterministic waveform defined
 * in absolute time (picoseconds), sampled at the requested rate:
 *
 *   CH0  UART 115200 8N1, "Hello, WebPulse!\r\n" then ~200 us idle
 *   CH1  SPI SCLK (1 MHz, mode 0), 8-byte burst every 100 us
 *   CH2  SPI MOSI (MSB first, incrementing bytes)
 *   CH3  SPI CS# (active low during the burst)
 *   CH4  PWM 10 kHz, duty sweeping 10..90 % over 10 ms
 *   CH5  250 kHz square wave
 *   CH6  pseudo-random level, new value every 3 us
 *   CH7  1 us pulse every 1 ms, every 10th pulse is 5 us wide
 */
#include "device.h"
#include "platform.h"
#include "util.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PS_US 1000000ull
#define PS_NS 1000ull

typedef struct {
    double speed;
    uint64_t rate;
    wp_sink *sink;
    pthread_t thread;
    int running;
    atomic_int stop;
} sim_priv;

static const char uart_msg[] = "Hello, WebPulse!\r\n";

static uint64_t mix64(uint64_t x)
{
    x += 0x9e3779b97f4a7c15ull;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ull;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebull;
    return x ^ (x >> 31);
}

/* Return the end time (exclusive) of the constant segment containing t and
 * store the channel level in *v. The end is always > t. */
static uint64_t seg(int ch, uint64_t t, int *v)
{
    switch (ch) {
    case 0: {   /* UART */
        const uint64_t bit_ps = 8680556;    /* 1 / 115200 s */
        const uint64_t nbits = (sizeof(uart_msg) - 1) * 10;
        const uint64_t idle_bits = 23;
        const uint64_t cycle = (nbits + idle_bits) * bit_ps;
        uint64_t base = t - t % cycle;
        uint64_t bit = (t - base) / bit_ps;
        if (bit >= nbits) {
            *v = 1;
            return base + cycle;
        }
        {
            uint64_t k = bit / 10, b = bit % 10;
            if (b == 0)
                *v = 0;
            else if (b == 9)
                *v = 1;
            else
                *v = ((unsigned char)uart_msg[k] >> (b - 1)) & 1;
        }
        return base + (bit + 1) * bit_ps;
    }
    case 1: case 2: case 3: {   /* SPI */
        const uint64_t period = 100 * PS_US;
        const uint64_t start = 2 * PS_US;
        const uint64_t bit_ps = 1 * PS_US;
        const uint64_t nbits = 64;
        uint64_t base = t - t % period;
        uint64_t off = t - base;
        uint64_t burst = t / period;
        uint64_t cs_end = start + nbits * bit_ps + PS_US / 2;
        if (ch == 3) {
            if (off < start) { *v = 1; return base + start; }
            if (off < cs_end) { *v = 0; return base + cs_end; }
            *v = 1;
            return base + period;
        }
        if (off < start || off >= start + nbits * bit_ps) {
            *v = 0;
            if (off < start)
                return base + start;
            return base + period;
        }
        {
            uint64_t bit = (off - start) / bit_ps;
            uint64_t bstart = base + start + bit * bit_ps;
            if (ch == 1) {          /* SCLK: low first half, high second half */
                if (t < bstart + bit_ps / 2) { *v = 0; return bstart + bit_ps / 2; }
                *v = 1;
                return bstart + bit_ps;
            }
            {
                uint8_t byte = (uint8_t)(burst * 8 + bit / 8);
                *v = (byte >> (7 - bit % 8)) & 1;
            }
            return bstart + bit_ps;
        }
    }
    case 4: {   /* PWM */
        const uint64_t period = 100 * PS_US;
        uint64_t n = t / period;
        uint64_t base = n * period;
        uint64_t phase = n % 100;   /* triangle over 100 periods */
        uint64_t tri = phase < 50 ? phase : 100 - phase;        /* 0..50 */
        uint64_t duty = period / 10 + period * 8 / 10 * tri / 50;
        if (t - base < duty) { *v = 1; return base + duty; }
        *v = 0;
        return base + period;
    }
    case 5: {   /* 250 kHz square */
        const uint64_t half = 2 * PS_US;
        uint64_t n = t / half;
        *v = (int)(n & 1);
        return (n + 1) * half;
    }
    case 6: {   /* pseudo-random */
        const uint64_t step = 3 * PS_US;
        uint64_t n = t / step;
        *v = (int)(mix64(n) & 1);
        return (n + 1) * step;
    }
    default: {  /* CH7: rare pulse */
        const uint64_t period = 1000 * PS_US;
        uint64_t n = t / period;
        uint64_t base = n * period;
        uint64_t width = (n % 10 == 9) ? 5 * PS_US : 1 * PS_US;
        if (t - base < width) { *v = 1; return base + width; }
        *v = 0;
        return base + period;
    }
    }
}

/* Fill buf with samples [i0, i0 + n) at the given rate. */
static void generate(uint8_t *buf, uint64_t i0, size_t n, uint64_t rate)
{
    int ch;
    uint64_t i1 = i0 + n;

    memset(buf, 0, n);
    for (ch = 0; ch < 8; ch++) {
        uint8_t bit = (uint8_t)(1u << ch);
        uint64_t i = i0;
        while (i < i1) {
            int v;
            uint64_t t = wp_sample_to_ps(i, rate);
            uint64_t end = seg(ch, t, &v);
            uint64_t j = wp_ps_to_sample_ceil(end, rate);
            if (j > i1)
                j = i1;
            if (j <= i)     /* cannot happen, but never loop forever */
                j = i + 1;
            if (v) {
                uint8_t *p = buf + (i - i0), *e = buf + (j - i0);
                for (; p < e; p++)
                    *p |= bit;
            }
            i = j;
        }
    }
}

/* Exposed for tests. */
void wp_sim_generate(uint8_t *buf, uint64_t i0, size_t n, uint64_t rate)
{
    generate(buf, i0, n, rate);
}

static void *sim_thread(void *arg)
{
    sim_priv *p = arg;
    size_t chunk = (size_t)(p->rate / 100);     /* 10 ms of data */
    uint8_t *buf;
    uint64_t pos = 0;
    uint64_t t_start = wp_now_us();

    if (chunk < 4096)
        chunk = 4096;
    if (chunk > (1u << 20))
        chunk = 1u << 20;
    buf = malloc(chunk);
    if (!buf) {
        p->sink->end(p->sink, -1, "sim: out of memory");
        return NULL;
    }

    while (!atomic_load(&p->stop)) {
        size_t off = 0;

        if (p->speed > 0) {
            /* Pace output so that pos <= elapsed * rate * speed. */
            double due = (double)(wp_now_us() - t_start) * 1e-6 * (double)p->rate * p->speed;
            if ((double)pos > due) {
                wp_sleep_ms(2);
                continue;
            }
        }
        generate(buf, pos, chunk, p->rate);
        while (off < chunk && !atomic_load(&p->stop)) {
            size_t w = p->sink->write(p->sink, buf + off, chunk - off);
            off += w;
            if (off < chunk)
                wp_sleep_ms(1);
        }
        pos += chunk;
    }
    free(buf);
    return NULL;
}

static int sim_open(wp_device *d, char *err, size_t errlen)
{
    (void)err; (void)errlen;
    d->is_open = 1;
    return 0;
}

static void sim_close(wp_device *d)
{
    d->is_open = 0;
}

static int sim_start(wp_device *d, uint64_t rate, wp_sink *sink, char *err, size_t errlen)
{
    sim_priv *p = d->priv;

    if (p->running) {
        snprintf(err, errlen, "sim: already running");
        return -1;
    }
    p->rate = rate;
    p->sink = sink;
    atomic_store(&p->stop, 0);
    if (pthread_create(&p->thread, NULL, sim_thread, p) != 0) {
        snprintf(err, errlen, "sim: cannot create thread");
        return -1;
    }
    p->running = 1;
    return 0;
}

static void sim_stop(wp_device *d)
{
    sim_priv *p = d->priv;
    if (!p->running)
        return;
    atomic_store(&p->stop, 1);
    pthread_join(p->thread, NULL);
    p->running = 0;
}

static void sim_info(wp_device *d, wp_device_info *info)
{
    (void)d;
    memset(info, 0, sizeof(*info));
    info->backend = "sim";
    wp_strlcpy(info->model, "WebPulse simulator", sizeof(info->model));
    info->rates = wp_fx2_rates;
    info->nrates = wp_fx2_nrates;
}

static void sim_destroy(wp_device *d)
{
    sim_stop(d);
    free(d->priv);
    free(d);
}

static const wp_device_ops sim_ops = {
    sim_open, sim_close, sim_start, sim_stop, sim_info, sim_destroy,
};

wp_device *wp_sim_new(double speed)
{
    wp_device *d = calloc(1, sizeof(*d));
    sim_priv *p = calloc(1, sizeof(*p));
    if (!d || !p) {
        free(d);
        free(p);
        return NULL;
    }
    p->speed = speed;
    atomic_init(&p->stop, 0);
    d->ops = &sim_ops;
    d->priv = p;
    return d;
}
