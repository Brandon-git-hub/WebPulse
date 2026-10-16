/*
 * FX2 backend: Cypress FX2(LP) boards running sigrok's fx2lafw firmware
 * (e.g. WeAct LogicAnalyzerV1 / CBM9002A). Uses libusb asynchronous bulk
 * transfers on EP2 IN; see fx2_proto.h for the protocol constants.
 *
 * Open sequence:
 *   1. find 0925:3881 (Saleae Logic IDs, EEPROM or fx2lafw) or 04b4:8613
 *      (blank FX2), open it and ask for the firmware version (0xB0)
 *   2. if that fails, download the firmware into RAM with request 0xA0
 *      (CPUCS reset, image, CPUCS run)
 *   3. the device disconnects and re-enumerates as 0925:3881; poll for it
 *      for up to 3 s and repeat step 1
 */
#include "device.h"
#include "fx2_proto.h"
#include "platform.h"
#include "util.h"

#include <libusb.h>
#include <pthread.h>
#ifdef _WIN32
#include <windows.h>
#endif
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CTRL_TIMEOUT_MS     1000
#define RENUM_WAIT_MS       3000
#define FW_MAX_SIZE         (16 * 1024)

typedef struct {
    char fw_path[1024];
    libusb_context *ctx;
    libusb_device_handle *h;
    char model[64];
    char fw_version[32];

    /* acquisition */
    wp_sink *sink;
    pthread_t thread;
    int running;
    pthread_mutex_t xlock;
    struct libusb_transfer *xfer[FX2_MAX_TRANSFERS];
    atomic_int active;
    atomic_int stop;
    atomic_int ended;
    atomic_int gone;            /* device disconnected during acquisition */
    unsigned nxfer;
    unsigned empty;
    uint64_t rx_bytes;          /* bytes received in this acquisition */
    uint64_t t_start_us;
    uint64_t rate;
    int raw_io;                 /* WinUSB RAW_IO enabled on the data endpoint */
} fx2_priv;

/* ---- open / firmware ----------------------------------------------------- */

static int is_candidate(const struct libusb_device_descriptor *d)
{
    return (d->idVendor == FX2_VID_SALEAE && d->idProduct == FX2_PID_SALEAE) ||
           (d->idVendor == FX2_VID_CYPRESS && d->idProduct == FX2_PID_CYPRESS);
}

/* Open the first matching device. Returns its descriptor in *desc. */
static libusb_device_handle *open_first(fx2_priv *p, struct libusb_device_descriptor *desc,
                                        char *err, size_t errlen)
{
    libusb_device **list;
    libusb_device_handle *h = NULL;
    ssize_t n, i;
    int last_rc = 0, found = 0;

    n = libusb_get_device_list(p->ctx, &list);
    if (n < 0) {
        snprintf(err, errlen, "libusb_get_device_list: %s", libusb_error_name((int)n));
        return NULL;
    }
    for (i = 0; i < n && !h; i++) {
        if (libusb_get_device_descriptor(list[i], desc) != 0 || !is_candidate(desc))
            continue;
        found = 1;
        last_rc = libusb_open(list[i], &h);
        if (last_rc != 0)
            h = NULL;
    }
    libusb_free_device_list(list, 1);
    if (!h) {
        if (found)
            snprintf(err, errlen, "cannot open FX2 device: %s%s", libusb_error_name(last_rc),
#ifdef _WIN32
                     " (install the WinUSB driver with Zadig)"
#else
                     " (check udev permissions)"
#endif
                     );
        else
            snprintf(err, errlen, "no FX2 logic analyzer found (looked for 0925:3881 and 04b4:8613)");
    }
    return h;
}

static int get_fw_version(libusb_device_handle *h, uint8_t ver[2])
{
    int r = libusb_control_transfer(h,
        LIBUSB_ENDPOINT_IN | LIBUSB_REQUEST_TYPE_VENDOR | LIBUSB_RECIPIENT_DEVICE,
        FX2_CMD_GET_FW_VERSION, 0, 0, ver, 2, 200);
    return r == 2 ? 0 : -1;
}

static int cpucs(libusb_device_handle *h, uint8_t v)
{
    int r = libusb_control_transfer(h,
        LIBUSB_ENDPOINT_OUT | LIBUSB_REQUEST_TYPE_VENDOR | LIBUSB_RECIPIENT_DEVICE,
        FX2_REQ_FIRMWARE, FX2_CPUCS_ADDR, 0, &v, 1, CTRL_TIMEOUT_MS);
    return r == 1 ? 0 : r;
}

static int upload_firmware(fx2_priv *p, libusb_device_handle *h, char *err, size_t errlen)
{
    FILE *f = fopen(p->fw_path, "rb");
    uint8_t *img;
    size_t len, off;
    int r;

    if (!f) {
        snprintf(err, errlen, "cannot open firmware %s", p->fw_path);
        return -1;
    }
    img = malloc(FW_MAX_SIZE + 1);
    len = img ? fread(img, 1, FW_MAX_SIZE + 1, f) : 0;
    fclose(f);
    if (!img || len == 0 || len > FW_MAX_SIZE) {
        snprintf(err, errlen, "invalid firmware image %s (%zu bytes)", p->fw_path, len);
        free(img);
        return -1;
    }

    /* Best effort: some platforms (WinUSB) cannot change the configuration. */
    libusb_set_configuration(h, 1);

    if ((r = cpucs(h, 1)) != 0) {
        snprintf(err, errlen, "firmware upload: cannot reset 8051: %s", libusb_error_name(r));
        free(img);
        return -1;
    }
    for (off = 0; off < len; off += FX2_FW_CHUNK) {
        size_t c = len - off < FX2_FW_CHUNK ? len - off : FX2_FW_CHUNK;
        r = libusb_control_transfer(h,
            LIBUSB_ENDPOINT_OUT | LIBUSB_REQUEST_TYPE_VENDOR | LIBUSB_RECIPIENT_DEVICE,
            FX2_REQ_FIRMWARE, (uint16_t)off, 0, img + off, (uint16_t)c, CTRL_TIMEOUT_MS);
        if (r != (int)c) {
            snprintf(err, errlen, "firmware upload failed at offset %zu: %s", off,
                     libusb_error_name(r));
            free(img);
            return -1;
        }
    }
    free(img);
    /* Releasing reset starts the firmware; the device then re-enumerates,
     * so this transfer may legitimately fail. */
    cpucs(h, 0);
    return 0;
}

/* Claim interface 0 and check for fx2lafw. Returns 0 if the firmware answers. */
static int probe(libusb_device_handle *h, uint8_t ver[2])
{
    libusb_set_auto_detach_kernel_driver(h, 1);
    if (libusb_claim_interface(h, 0) != 0)
        return -1;
    if (get_fw_version(h, ver) != 0) {
        libusb_release_interface(h, 0);
        return -1;
    }
    return 0;
}

static int fx2_open(wp_device *d, char *err, size_t errlen)
{
    fx2_priv *p = d->priv;
    struct libusb_device_descriptor desc;
    libusb_device_handle *h;
    uint8_t ver[2];
    int r;

    if (!p->ctx && (r = libusb_init_context(&p->ctx, NULL, 0)) != 0) {
        snprintf(err, errlen, "libusb init failed: %s", libusb_error_name(r));
        p->ctx = NULL;
        return -1;
    }

    h = open_first(p, &desc, err, errlen);
    if (!h)
        return -1;

    if (probe(h, ver) != 0) {
        uint64_t t0;
        fprintf(stderr, "fx2: uploading firmware %s\n", p->fw_path);
        if (upload_firmware(p, h, err, errlen) < 0) {
            libusb_close(h);
            return -1;
        }
        libusb_close(h);
        h = NULL;

        /* Wait for the device to come back with the new firmware. */
        wp_sleep_ms(300);
        t0 = wp_now_ms();
        while (wp_now_ms() - t0 < RENUM_WAIT_MS) {
            char e2[160];
            h = open_first(p, &desc, e2, sizeof(e2));
            if (h && desc.idVendor == FX2_VID_SALEAE && probe(h, ver) == 0)
                break;
            if (h) {
                libusb_close(h);
                h = NULL;
            }
            wp_sleep_ms(100);
        }
        if (!h) {
            snprintf(err, errlen, "device did not re-enumerate with fx2lafw firmware "
                     "within %d ms", RENUM_WAIT_MS);
            return -1;
        }
    }

    if (ver[0] != FX2_FW_MAJOR) {
        snprintf(err, errlen, "unsupported fx2lafw firmware version %u.%u (need %u.x)",
                 ver[0], ver[1], FX2_FW_MAJOR);
        libusb_release_interface(h, 0);
        libusb_close(h);
        return -1;
    }

    p->h = h;
    atomic_store(&p->gone, 0);
    snprintf(p->fw_version, sizeof(p->fw_version), "fx2lafw %u.%u", ver[0], ver[1]);
    {
        char prod[48] = "";
        if (desc.iProduct)
            libusb_get_string_descriptor_ascii(h, desc.iProduct, (unsigned char *)prod,
                                               sizeof(prod));
        /* Full speed (e.g. behind a USB 1.1 hub) cannot sustain more than
         * about 1 MB/s; flag it so overflows at high rates make sense. */
        int full = libusb_get_device_speed(libusb_get_device(h)) == LIBUSB_SPEED_FULL;
        snprintf(p->model, sizeof(p->model), "%s (%04x:%04x)%s", prod[0] ? prod : "FX2",
                 desc.idVendor, desc.idProduct, full ? " FULL-SPEED USB" : "");
        if (full)
            fprintf(stderr, "fx2: warning: device is connected at USB full speed; "
                            "rates above ~1 MHz will overflow\n");
    }
    d->is_open = 1;
    return 0;
}

static void fx2_close(wp_device *d)
{
    fx2_priv *p = d->priv;
    if (p->h) {
        libusb_release_interface(p->h, 0);
        libusb_close(p->h);
        p->h = NULL;
    }
    p->model[0] = '\0';
    p->fw_version[0] = '\0';
    p->raw_io = 0;
    d->is_open = 0;
}

/* ---- acquisition --------------------------------------------------------- */

static void end_once(fx2_priv *p, int err, const char *msg);

/* Overflow message with how far the stream got, e.g. to tell a slow start
 * from a gap in the middle of a capture. */
static void end_overflow(fx2_priv *p, const char *what)
{
    char msg[160];
    double ms = (double)(wp_now_us() - p->t_start_us) / 1000.0;
    snprintf(msg, sizeof(msg), "%s after %.1f MB / %.0f ms at %.1f MHz%s", what,
             (double)p->rx_bytes / 1e6, ms, (double)p->rate / 1e6,
             p->raw_io ? "" : ", RAW_IO off");
    fprintf(stderr, "fx2: %s\n", msg);
    end_once(p, WP_DEV_ERR_OVERFLOW, msg);
}

static void end_once(fx2_priv *p, int err, const char *msg)
{
    int expected = 0;
    if (atomic_compare_exchange_strong(&p->ended, &expected, 1))
        p->sink->end(p->sink, err, msg);
    atomic_store(&p->stop, 1);
}

static void free_xfer(fx2_priv *p, struct libusb_transfer *x)
{
    unsigned i;
    pthread_mutex_lock(&p->xlock);
    for (i = 0; i < p->nxfer; i++)
        if (p->xfer[i] == x)
            p->xfer[i] = NULL;
    pthread_mutex_unlock(&p->xlock);
    free(x->buffer);
    libusb_free_transfer(x);
    atomic_fetch_sub(&p->active, 1);
}

static void LIBUSB_CALL xfer_cb(struct libusb_transfer *x)
{
    fx2_priv *p = x->user_data;

    if (atomic_load(&p->stop)) {
        free_xfer(p, x);
        return;
    }

    switch (x->status) {
    case LIBUSB_TRANSFER_COMPLETED:
    case LIBUSB_TRANSFER_TIMED_OUT:
        if (x->actual_length > 0) {
            size_t len = (size_t)x->actual_length;
            p->empty = 0;
            if (p->sink->write(p->sink, x->buffer, len) < len) {
                end_overflow(p, "host ring buffer full");
                break;
            }
            p->rx_bytes += len;
        } else if (++p->empty > p->nxfer * 2) {
            /* fx2lafw stops streaming when its FIFO overflows. */
            end_overflow(p, "FX2 FIFO overflow (USB read gap)");
            break;
        }
        if (libusb_submit_transfer(x) != 0) {
            end_once(p, WP_DEV_ERR_IO, "cannot resubmit USB transfer");
            break;
        }
        return;
    case LIBUSB_TRANSFER_NO_DEVICE:
        atomic_store(&p->gone, 1);
        end_once(p, WP_DEV_ERR_IO, "device disconnected");
        break;
    case LIBUSB_TRANSFER_CANCELLED:
        break;
    default: {
        static const char *const names[] = {
            "completed", "error", "timed out", "cancelled", "stall", "no device", "overflow",
        };
        char msg[64];
        snprintf(msg, sizeof(msg), "USB transfer failed: %s",
                 (unsigned)x->status < sizeof(names) / sizeof(names[0]) ? names[x->status]
                                                                        : "unknown status");
        end_once(p, WP_DEV_ERR_IO, msg);
        break;
    }
    }
    free_xfer(p, x);
}

static void cancel_all(fx2_priv *p)
{
    unsigned i;
    pthread_mutex_lock(&p->xlock);
    for (i = 0; i < p->nxfer; i++)
        if (p->xfer[i])
            libusb_cancel_transfer(p->xfer[i]);
    pthread_mutex_unlock(&p->xlock);
}

static void *event_thread(void *arg)
{
    fx2_priv *p = arg;
    int cancelled = 0;

#ifdef _WIN32
    /* The FX2 FIFO holds well under 1 ms of data at high rates, so the
     * resubmission path must not be pre-empted by e.g. the browser. */
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
#endif
    while (atomic_load(&p->active) > 0) {
        struct timeval tv = { 0, 100000 };
        if (atomic_load(&p->stop) && !cancelled) {
            cancel_all(p);
            cancelled = 1;
        }
        libusb_handle_events_timeout_completed(p->ctx, &tv, NULL);
    }
    return NULL;
}

/*
 * WinUSB by default handles the reads queued on a pipe one after another, which
 * leaves a short gap between transfers; at a few MHz that is longer than the
 * FX2 FIFO (4 x 512 bytes) can absorb, the FIFO fills and fx2lafw stops. RAW_IO
 * hands all queued reads to the host controller at once. It requires every
 * transfer to be a multiple of the packet size and at most the size reported
 * by WinUSB. Elsewhere this returns NOT_SUPPORTED and nothing changes.
 */
static void enable_raw_io(fx2_priv *p, size_t *size)
{
#if defined(LIBUSB_API_VERSION) && LIBUSB_API_VERSION >= 0x0100010C
    int max, r;

    if (p->raw_io)
        goto clamp;
    r = libusb_endpoint_set_raw_io(p->h, FX2_EP_DATA_IN, 1);
    if (r != 0) {
        if (r != LIBUSB_ERROR_NOT_SUPPORTED)
            fprintf(stderr, "fx2: cannot enable WinUSB RAW_IO: %s\n", libusb_error_name(r));
        return;
    }
    p->raw_io = 1;
clamp:
    max = libusb_get_max_raw_io_transfer_size(p->h, FX2_EP_DATA_IN);
    if (p->raw_io == 1) {
        p->raw_io = 2;
        fprintf(stderr, "fx2: WinUSB RAW_IO enabled (max transfer %d bytes)\n", max);
    }
    if (max >= 512 && *size > (size_t)max)
        *size = (size_t)max & ~(size_t)511;
#else
    (void)p;
    (void)size;
#endif
}

static int fx2_start(wp_device *d, uint64_t rate, wp_sink *sink, char *err, size_t errlen)
{
    fx2_priv *p = d->priv;
    uint8_t cmd[3];
    size_t size;
    unsigned i, timeout;
    int r;

    if (!p->h) {
        snprintf(err, errlen, "fx2: device not open");
        return -1;
    }
    if (wp_fx2_start_payload(rate, cmd) < 0) {
        snprintf(err, errlen, "fx2: unsupported sample rate %llu", (unsigned long long)rate);
        return -1;
    }
    size = wp_fx2_transfer_size(rate);
    p->nxfer = wp_fx2_num_transfers(rate);
    timeout = wp_fx2_timeout_ms(rate);
    enable_raw_io(p, &size);
    p->sink = sink;
    p->empty = 0;
    p->rx_bytes = 0;
    p->rate = rate;
    atomic_store(&p->stop, 0);
    atomic_store(&p->ended, 0);
    atomic_store(&p->active, 0);
    memset(p->xfer, 0, sizeof(p->xfer));

    /* Queue all transfers first, then start the GPIF (as libsigrok does). */
    for (i = 0; i < p->nxfer; i++) {
        struct libusb_transfer *x = libusb_alloc_transfer(0);
        uint8_t *buf = malloc(size);
        if (!x || !buf) {
            libusb_free_transfer(x);
            free(buf);
            snprintf(err, errlen, "fx2: out of memory");
            goto fail;
        }
        libusb_fill_bulk_transfer(x, p->h, FX2_EP_DATA_IN, buf, (int)size, xfer_cb, p, timeout);
        if ((r = libusb_submit_transfer(x)) != 0) {
            free(buf);
            libusb_free_transfer(x);
            snprintf(err, errlen, "fx2: cannot submit transfer: %s", libusb_error_name(r));
            if (r == LIBUSB_ERROR_NO_DEVICE)
                atomic_store(&p->gone, 1);
            goto fail;
        }
        pthread_mutex_lock(&p->xlock);
        p->xfer[i] = x;
        pthread_mutex_unlock(&p->xlock);
        atomic_fetch_add(&p->active, 1);
    }

    if (pthread_create(&p->thread, NULL, event_thread, p) != 0) {
        snprintf(err, errlen, "fx2: cannot create USB thread");
        goto fail;
    }
    p->running = 1;

    p->t_start_us = wp_now_us();
    r = libusb_control_transfer(p->h,
        LIBUSB_ENDPOINT_OUT | LIBUSB_REQUEST_TYPE_VENDOR | LIBUSB_RECIPIENT_DEVICE,
        FX2_CMD_START, 0, 0, cmd, sizeof(cmd), CTRL_TIMEOUT_MS);
    if (r != (int)sizeof(cmd)) {
        snprintf(err, errlen, "fx2: start command failed: %s", libusb_error_name(r));
        atomic_store(&p->ended, 1);     /* do not report through the sink */
        atomic_store(&p->stop, 1);
        pthread_join(p->thread, NULL);
        p->running = 0;
        if (r == LIBUSB_ERROR_NO_DEVICE)
            fx2_close(d);
        return -1;
    }
    return 0;

fail:
    /* Cancel what was submitted and drain the callbacks. */
    atomic_store(&p->ended, 1);
    atomic_store(&p->stop, 1);
    cancel_all(p);
    while (atomic_load(&p->active) > 0) {
        struct timeval tv = { 0, 100000 };
        libusb_handle_events_timeout_completed(p->ctx, &tv, NULL);
    }
    if (atomic_load(&p->gone))
        fx2_close(d);
    return -1;
}

static void fx2_stop(wp_device *d)
{
    fx2_priv *p = d->priv;
    if (!p->running)
        return;
    atomic_store(&p->stop, 1);
    pthread_join(p->thread, NULL);
    p->running = 0;
    /* Drop the stale handle; the next capture re-opens the device. */
    if (atomic_load(&p->gone))
        fx2_close(d);
}

static void fx2_info(wp_device *d, wp_device_info *info)
{
    fx2_priv *p = d->priv;
    memset(info, 0, sizeof(*info));
    info->backend = "fx2";
    wp_strlcpy(info->model, p->model[0] ? p->model : "FX2 (not connected)", sizeof(info->model));
    wp_strlcpy(info->firmware, p->fw_version, sizeof(info->firmware));
    info->rates = wp_fx2_rates;
    info->nrates = wp_fx2_nrates;
}

static void fx2_destroy(wp_device *d)
{
    fx2_priv *p = d->priv;
    fx2_stop(d);
    fx2_close(d);
    if (p->ctx)
        libusb_exit(p->ctx);
    pthread_mutex_destroy(&p->xlock);
    free(p);
    free(d);
}

static const wp_device_ops fx2_ops = {
    fx2_open, fx2_close, fx2_start, fx2_stop, fx2_info, fx2_destroy,
};

wp_device *wp_fx2_new(const char *firmware_path)
{
    wp_device *d = calloc(1, sizeof(*d));
    fx2_priv *p = calloc(1, sizeof(*p));
    if (!d || !p) {
        free(d);
        free(p);
        return NULL;
    }
    wp_strlcpy(p->fw_path, firmware_path, sizeof(p->fw_path));
    pthread_mutex_init(&p->xlock, NULL);
    atomic_init(&p->active, 0);
    atomic_init(&p->stop, 0);
    atomic_init(&p->ended, 0);
    atomic_init(&p->gone, 0);
    d->ops = &fx2_ops;
    d->priv = p;
    return d;
}
