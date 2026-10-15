#include "capture.h"
#include "platform.h"
#include "ringbuf.h"
#include "trigger.h"
#include "util.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct wp_engine {
    wp_device *dev;
    uint64_t max_samples;

    pthread_mutex_t lock;       /* protects st, store, worker bookkeeping */
    wp_capture_status st;
    wp_store *store;
    pthread_t worker;
    int worker_valid;
    atomic_int busy;
    atomic_int stop_req;

    /* Per-capture state (owned by worker) */
    wp_capture_cfg cfg;
    wp_ringbuf rb;
    atomic_int dev_ended;
    atomic_int dev_err;
    atomic_int overflow;
    char dev_msg[128];
};

const char *wp_state_name(wp_state s)
{
    switch (s) {
    case WP_ST_IDLE: return "idle";
    case WP_ST_ARMED: return "armed";
    case WP_ST_CAPTURING: return "capturing";
    case WP_ST_PROCESSING: return "processing";
    case WP_ST_DONE: return "done";
    case WP_ST_ERROR: return "error";
    }
    return "?";
}

/* ---- sink: device thread -> ring buffer ------------------------------- */

static size_t sink_write(wp_sink *s, const uint8_t *data, size_t len)
{
    wp_engine *e = s->user;
    return wp_ringbuf_write(&e->rb, data, len);
}

static void sink_end(wp_sink *s, int err, const char *msg)
{
    wp_engine *e = s->user;
    if (msg)
        wp_strlcpy(e->dev_msg, msg, sizeof(e->dev_msg));
    atomic_store(&e->dev_err, err);
    if (err == WP_DEV_ERR_OVERFLOW)
        atomic_store(&e->overflow, 1);
    atomic_store(&e->dev_ended, 1);
}

/* ---- state helpers ---------------------------------------------------- */

static void set_state(wp_engine *e, wp_state s)
{
    pthread_mutex_lock(&e->lock);
    e->st.state = s;
    e->st.seq++;
    pthread_mutex_unlock(&e->lock);
}

static void set_error(wp_engine *e, const char *fmt, ...)
{
    va_list ap;
    pthread_mutex_lock(&e->lock);
    va_start(ap, fmt);
    vsnprintf(e->st.error, sizeof(e->st.error), fmt, ap);
    va_end(ap);
    e->st.state = WP_ST_ERROR;
    e->st.seq++;
    pthread_mutex_unlock(&e->lock);
}

/* Rotate buf[0..n) left by k, in place (three reversals). */
static void reverse(uint8_t *p, size_t n)
{
    size_t i;
    for (i = 0; i < n / 2; i++) {
        uint8_t t = p[i];
        p[i] = p[n - 1 - i];
        p[n - 1 - i] = t;
    }
}

static void rotate_left(uint8_t *p, size_t n, size_t k)
{
    if (n == 0 || k % n == 0)
        return;
    k %= n;
    reverse(p, k);
    reverse(p + k, n - k);
    reverse(p, n);
}

/* ---- worker ----------------------------------------------------------- */

static void *worker_main(void *arg)
{
    wp_engine *e = arg;
    const wp_capture_cfg *cfg = &e->cfg;
    wp_trigger trig;
    wp_sink sink = { sink_write, sink_end, e };
    uint8_t *buf;
    uint64_t N = cfg->samples;
    uint64_t P = 0;             /* pre-trigger capacity */
    uint64_t pre_w = 0, pre_cnt = 0;
    uint64_t filled = 0;
    int64_t trig_pos = -1;
    int triggered = 0, have_prev = 0, aborted = 0;
    uint8_t prev = 0;
    uint64_t t0 = wp_now_ms();
    uint64_t last_status = 0;
    char err[160];
    size_t rbsize;

    wp_trigger_parse(cfg->trigger, &trig);
    if (wp_trigger_is_none(&trig)) {
        triggered = 1;
    } else {
        P = (uint64_t)((double)N * cfg->pre_ratio + 0.5);
        if (P > N)
            P = N;
    }

    buf = malloc(N ? N : 1);
    if (!buf) {
        set_error(e, "cannot allocate %llu bytes for the capture",
                  (unsigned long long)N);
        goto out;
    }

    /* Ring buffer: ~0.5 s of data, 4 MB .. 64 MB. */
    rbsize = (size_t)(cfg->rate / 2);
    if (rbsize < (4u << 20))
        rbsize = 4u << 20;
    if (rbsize > (64u << 20))
        rbsize = 64u << 20;
    if (wp_ringbuf_init(&e->rb, rbsize) < 0) {
        free(buf);
        set_error(e, "cannot allocate ring buffer");
        goto out;
    }
    atomic_store(&e->dev_ended, 0);
    atomic_store(&e->dev_err, 0);
    atomic_store(&e->overflow, 0);
    e->dev_msg[0] = '\0';

    set_state(e, triggered ? WP_ST_CAPTURING : WP_ST_ARMED);

    if (e->dev->ops->start(e->dev, cfg->rate, &sink, err, sizeof(err)) < 0) {
        wp_ringbuf_free(&e->rb);
        free(buf);
        set_error(e, "%s", err);
        goto out;
    }

    while (filled < N) {
        const uint8_t *p;
        size_t n = wp_ringbuf_peek(&e->rb, &p), used = 0;

        if (atomic_load(&e->stop_req)) {
            aborted = 1;
            break;
        }
        if (atomic_load(&e->overflow)) {
            aborted = 2;
            break;
        }
        if (n == 0) {
            if (atomic_load(&e->dev_ended)) {
                aborted = 3;
                break;
            }
            if (!triggered && cfg->timeout_ms &&
                wp_now_ms() - t0 > cfg->timeout_ms) {
                aborted = 4;
                break;
            }
            wp_sleep_ms(1);
            continue;
        }

        if (!triggered) {
            ptrdiff_t idx = wp_trigger_find(&trig, prev, have_prev, p, n);
            size_t pre_part = idx < 0 ? n : (size_t)idx;
            const uint8_t *q = p;
            size_t left = pre_part;

            /* Append samples before the trigger to the pre-trigger ring. */
            if (P > 0) {
                if (left > P) {          /* only the last P matter */
                    q += left - P;
                    left = (size_t)P;
                }
                while (left) {
                    size_t c = (size_t)(P - pre_w);
                    if (c > left)
                        c = left;
                    memcpy(buf + pre_w, q, c);
                    pre_w = (pre_w + c) % P;
                    q += c;
                    left -= c;
                    pre_cnt += c;
                }
                if (pre_cnt > P)
                    pre_cnt = P;
            }
            if (pre_part) {
                prev = p[pre_part - 1];
                have_prev = 1;
            }
            used = pre_part;

            if (idx >= 0) {
                /* Linearise the ring so the oldest sample is at buf[0]. */
                if (pre_cnt == P)
                    rotate_left(buf, (size_t)P, (size_t)pre_w);
                filled = pre_cnt;
                trig_pos = (int64_t)pre_cnt;
                triggered = 1;
                pthread_mutex_lock(&e->lock);
                e->st.trigger_pos = trig_pos;
                e->st.state = WP_ST_CAPTURING;
                e->st.seq++;
                pthread_mutex_unlock(&e->lock);
            }
        }

        if (triggered && used < n) {
            size_t c = n - used;
            if (c > N - filled)
                c = (size_t)(N - filled);
            memcpy(buf + filled, p + used, c);
            filled += c;
            used += c;
        }
        wp_ringbuf_consume(&e->rb, used);

        if (wp_now_ms() - last_status > 50) {
            last_status = wp_now_ms();
            pthread_mutex_lock(&e->lock);
            e->st.filled = triggered ? filled : pre_cnt;
            e->st.elapsed_ms = last_status - t0;
            pthread_mutex_unlock(&e->lock);
        }
    }

    e->dev->ops->stop(e->dev);
    wp_ringbuf_free(&e->rb);

    pthread_mutex_lock(&e->lock);
    e->st.filled = triggered ? filled : pre_cnt;
    e->st.elapsed_ms = wp_now_ms() - t0;
    pthread_mutex_unlock(&e->lock);

    if (aborted == 2) {
        free(buf);
        set_error(e, "data overflow: the host did not read samples fast enough "
                     "(try a lower sample rate)");
        goto out;
    }
    if (aborted == 3 && !(triggered && filled > 0)) {
        free(buf);
        set_error(e, "device stopped: %s", e->dev_msg[0] ? e->dev_msg : "end of stream");
        goto out;
    }
    if (aborted == 4) {
        free(buf);
        set_error(e, "trigger timeout after %u ms", cfg->timeout_ms);
        goto out;
    }
    if (aborted == 1 && !triggered) {
        free(buf);
        set_state(e, WP_ST_IDLE);
        goto out;
    }

    /* Triggered (or no trigger) and either complete or stopped early. */
    set_state(e, WP_ST_PROCESSING);
    {
        wp_store *s = wp_store_new(buf, filled, cfg->rate, trig_pos);
        if (!s) {
            set_error(e, "out of memory while building the capture index");
            goto out;
        }
        pthread_mutex_lock(&e->lock);
        if (e->store)
            wp_store_unref(e->store);
        e->store = s;
        e->st.state = WP_ST_DONE;
        e->st.filled = filled;
        if (aborted == 3)
            snprintf(e->st.error, sizeof(e->st.error), "device stopped early: %s",
                     e->dev_msg[0] ? e->dev_msg : "end of stream");
        e->st.seq++;
        pthread_mutex_unlock(&e->lock);
    }

out:
    atomic_store(&e->busy, 0);
    return NULL;
}

/* ---- public API ------------------------------------------------------- */

wp_engine *wp_engine_new(wp_device *dev, uint64_t max_samples)
{
    wp_engine *e = calloc(1, sizeof(*e));
    if (!e)
        return NULL;
    e->dev = dev;
    e->max_samples = max_samples;
    pthread_mutex_init(&e->lock, NULL);
    atomic_init(&e->busy, 0);
    atomic_init(&e->stop_req, 0);
    atomic_init(&e->dev_ended, 0);
    atomic_init(&e->dev_err, 0);
    atomic_init(&e->overflow, 0);
    e->st.state = WP_ST_IDLE;
    e->st.trigger_pos = -1;
    return e;
}

void wp_engine_free(wp_engine *e)
{
    if (!e)
        return;
    wp_engine_stop(e);
    if (e->worker_valid)
        pthread_join(e->worker, NULL);
    if (e->store)
        wp_store_unref(e->store);
    pthread_mutex_destroy(&e->lock);
    free(e);
}

static int validate(wp_engine *e, const wp_capture_cfg *cfg, wp_trigger *trig,
                    char *err, size_t errlen)
{
    if (!e->dev->is_open) {
        snprintf(err, errlen, "device is not open");
        return -1;
    }
    if (!wp_device_rate_supported(e->dev, cfg->rate)) {
        snprintf(err, errlen, "unsupported sample rate %llu Hz",
                 (unsigned long long)cfg->rate);
        return -1;
    }
    if (cfg->samples < 16 || cfg->samples > e->max_samples) {
        snprintf(err, errlen, "sample count must be between 16 and %llu",
                 (unsigned long long)e->max_samples);
        return -1;
    }
    if (cfg->pre_ratio < 0 || cfg->pre_ratio > 1) {
        snprintf(err, errlen, "pre-trigger ratio must be within 0..1");
        return -1;
    }
    if (wp_trigger_parse(cfg->trigger, trig) < 0) {
        snprintf(err, errlen, "invalid trigger \"%s\" (8 chars of X01RFE)", cfg->trigger);
        return -1;
    }
    return 0;
}

int wp_engine_start(wp_engine *e, const wp_capture_cfg *cfg, char *err, size_t errlen)
{
    wp_trigger trig;
    int expected = 0;

    if (!atomic_compare_exchange_strong(&e->busy, &expected, 1)) {
        snprintf(err, errlen, "a capture is already running");
        return -1;
    }
    if (validate(e, cfg, &trig, err, errlen) < 0) {
        atomic_store(&e->busy, 0);
        return -1;
    }

    if (e->worker_valid) {
        pthread_join(e->worker, NULL);
        e->worker_valid = 0;
    }

    e->cfg = *cfg;
    atomic_store(&e->stop_req, 0);

    pthread_mutex_lock(&e->lock);
    /* Drop the previous capture so its memory is released (readers that
     * still hold a reference keep it alive until they finish). */
    if (e->store) {
        wp_store_unref(e->store);
        e->store = NULL;
    }
    memset(&e->st.error, 0, sizeof(e->st.error));
    e->st.rate = cfg->rate;
    e->st.samples = cfg->samples;
    e->st.filled = 0;
    e->st.elapsed_ms = 0;
    e->st.trigger_pos = -1;
    wp_trigger_format(&trig, e->st.trigger);
    if (wp_trigger_is_none(&trig))
        e->st.trigger[0] = '\0';
    e->st.state = WP_ST_ARMED;
    e->st.seq++;
    pthread_mutex_unlock(&e->lock);

    if (pthread_create(&e->worker, NULL, worker_main, e) != 0) {
        atomic_store(&e->busy, 0);
        set_error(e, "cannot create worker thread");
        snprintf(err, errlen, "cannot create worker thread");
        return -1;
    }
    e->worker_valid = 1;
    return 0;
}

void wp_engine_stop(wp_engine *e)
{
    atomic_store(&e->stop_req, 1);
}

int wp_engine_busy(wp_engine *e)
{
    return atomic_load(&e->busy);
}

int wp_engine_wait(wp_engine *e, uint32_t timeout_ms)
{
    uint64_t t0 = wp_now_ms();
    while (atomic_load(&e->busy)) {
        if (timeout_ms && wp_now_ms() - t0 >= timeout_ms)
            return 0;
        wp_sleep_ms(5);
    }
    return 1;
}

void wp_engine_status(wp_engine *e, wp_capture_status *st)
{
    pthread_mutex_lock(&e->lock);
    *st = e->st;
    pthread_mutex_unlock(&e->lock);
}

uint64_t wp_engine_max_samples(wp_engine *e)
{
    return e->max_samples;
}

wp_device *wp_engine_device(wp_engine *e)
{
    return e->dev;
}

wp_store *wp_engine_store(wp_engine *e)
{
    wp_store *s;
    pthread_mutex_lock(&e->lock);
    s = e->store;
    if (s)
        wp_store_ref(s);
    pthread_mutex_unlock(&e->lock);
    return s;
}
