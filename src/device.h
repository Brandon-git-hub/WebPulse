/*
 * Device backend interface.
 *
 * A backend produces raw 8-bit samples (bit c = channel c) and pushes them
 * into a wp_sink from its own thread. The sink must never block; when it
 * returns a short count the consumer is not keeping up. Real hardware treats
 * that as an overflow, the simulator simply retries (backpressure).
 */
#ifndef WP_DEVICE_H
#define WP_DEVICE_H

#include <stddef.h>
#include <stdint.h>

/* err codes passed to wp_sink.end() */
#define WP_DEV_ERR_IO        (-1)
#define WP_DEV_ERR_OVERFLOW  (-2)   /* samples were lost */

typedef struct wp_sink wp_sink;
struct wp_sink {
    size_t (*write)(wp_sink *s, const uint8_t *data, size_t len);
    /* Called once when acquisition ends on the device side (error or EOF).
     * err == 0 means a normal end of stream. */
    void (*end)(wp_sink *s, int err, const char *msg);
    void *user;
};

typedef struct {
    const char *backend;        /* "sim" or "fx2" */
    char model[64];
    char firmware[32];          /* empty if not applicable */
    const uint64_t *rates;
    size_t nrates;
} wp_device_info;

typedef struct wp_device wp_device;
typedef struct {
    int  (*open)(wp_device *d, char *err, size_t errlen);
    void (*close)(wp_device *d);
    int  (*start)(wp_device *d, uint64_t rate, wp_sink *sink, char *err, size_t errlen);
    /* Synchronous: once it returns, the backend makes no more sink calls. */
    void (*stop)(wp_device *d);
    void (*info)(wp_device *d, wp_device_info *info);
    void (*destroy)(wp_device *d);
} wp_device_ops;

struct wp_device {
    const wp_device_ops *ops;
    void *priv;
    int is_open;
};

/* Sample rates supported by fx2lafw (same list as libsigrok). */
extern const uint64_t wp_fx2_rates[];
extern const size_t wp_fx2_nrates;

int wp_device_rate_supported(wp_device *d, uint64_t rate);

/* speed: 1.0 = real time, 0 = as fast as the consumer allows. */
wp_device *wp_sim_new(double speed);

#ifdef WP_HAVE_FX2
wp_device *wp_fx2_new(const char *firmware_path);
#endif

static inline void wp_device_destroy(wp_device *d)
{
    if (d)
        d->ops->destroy(d);
}

#endif
