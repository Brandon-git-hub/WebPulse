#include "capture.h"
#include "test.h"

#include <string.h>

void wp_sim_generate(uint8_t *buf, uint64_t i0, size_t n, uint64_t rate);

static wp_store *run(wp_engine *e, uint64_t samples, double pre, const char *trig,
                     uint32_t timeout_ms, wp_capture_status *st)
{
    wp_capture_cfg cfg;
    char err[160];

    memset(&cfg, 0, sizeof(cfg));
    cfg.rate = 24000000;
    cfg.samples = samples;
    cfg.pre_ratio = pre;
    cfg.timeout_ms = timeout_ms;
    strcpy(cfg.trigger, trig);
    if (wp_engine_start(e, &cfg, err, sizeof(err)) != 0) {
        fprintf(stderr, "start failed: %s\n", err);
        return NULL;
    }
    CHECK(wp_engine_wait(e, 20000));
    wp_engine_status(e, st);
    return wp_engine_store(e);
}

int main(void)
{
    const uint64_t N = 1000000;
    wp_device *dev = wp_sim_new(0);
    wp_engine *e;
    wp_capture_status st;
    wp_store *s;
    uint8_t *ref = malloc(N + 100000);
    char err[160];

    CHECK(dev->ops->open(dev, err, sizeof(err)) == 0);
    e = wp_engine_new(dev, 64u << 20);
    wp_sim_generate(ref, 0, N + 100000, 24000000);

    /* Sim sanity: CH7 high at t=0, falls after 1 us (24 samples), rises at 1 ms */
    CHECK((ref[0] & 0x80) && (ref[23] & 0x80) && !(ref[24] & 0x80));
    CHECK(!(ref[23999] & 0x80) && (ref[24000] & 0x80));
    /* CH0 UART idles high, start bit at t=0 */
    CHECK(!(ref[0] & 0x01));

    /* 1. No trigger: plain copy of the stream */
    s = run(e, N, 0, "", 0, &st);
    CHECK(s && st.state == WP_ST_DONE);
    if (s) {
        CHECK_EQ_U(s->n, N);
        CHECK(s->trigger_pos == -1);
        CHECK(memcmp(s->raw, ref, N) == 0);
        wp_store_unref(s);
    }

    /* 2. Trigger with fewer pre-samples available than requested */
    s = run(e, N, 0.25, "XXXXXXXR", 0, &st);
    CHECK(s && st.state == WP_ST_DONE);
    if (s) {
        CHECK_EQ_U(s->trigger_pos, 24000);
        CHECK_EQ_U(s->n, N);
        CHECK(memcmp(s->raw, ref, N) == 0);
        wp_store_unref(s);
    }

    /* 3. Pre-trigger ring wraps: 1% of 1M = 10000 samples before trigger */
    s = run(e, N, 0.01, "XXXXXXXR", 0, &st);
    CHECK(s && st.state == WP_ST_DONE);
    if (s) {
        CHECK_EQ_U(s->trigger_pos, 10000);
        CHECK_EQ_U(s->n, N);
        CHECK(memcmp(s->raw, ref + 14000, N) == 0);
        CHECK(s->raw[10000] & 0x80);
        CHECK(!(s->raw[9999] & 0x80));
        wp_store_unref(s);
    }

    /* 4. Impossible trigger -> timeout error, no store */
    s = run(e, N, 0.5, "11111111", 200, &st);
    CHECK(s == NULL);
    CHECK(st.state == WP_ST_ERROR);
    CHECK(strstr(st.error, "timeout") != NULL);

    /* 5. Validation */
    {
        wp_capture_cfg cfg;
        memset(&cfg, 0, sizeof(cfg));
        cfg.rate = 7000000;
        cfg.samples = N;
        CHECK(wp_engine_start(e, &cfg, err, sizeof(err)) < 0);
        cfg.rate = 24000000;
        strcpy(cfg.trigger, "XXQ");
        CHECK(wp_engine_start(e, &cfg, err, sizeof(err)) < 0);
        CHECK(!wp_engine_busy(e));
    }

    /* 6. Stop while armed -> idle, no store */
    {
        wp_capture_cfg cfg;
        memset(&cfg, 0, sizeof(cfg));
        cfg.rate = 24000000;
        cfg.samples = N;
        cfg.pre_ratio = 0.5;
        strcpy(cfg.trigger, "11111111");
        CHECK(wp_engine_start(e, &cfg, err, sizeof(err)) == 0);
        CHECK(wp_engine_start(e, &cfg, err, sizeof(err)) < 0);     /* busy */
        wp_engine_stop(e);
        CHECK(wp_engine_wait(e, 5000));
        wp_engine_status(e, &st);
        CHECK(st.state == WP_ST_IDLE);
        CHECK(wp_engine_store(e) == NULL);
    }

    wp_engine_free(e);
    wp_device_destroy(dev);
    free(ref);
    TEST_DONE();
}
