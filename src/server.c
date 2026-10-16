/*
 * REST API
 *   GET  /api/device                     backend info and supported rates
 *   POST /api/capture  {rate, samples, pre, trigger, timeout_ms}
 *   POST /api/stop
 *   GET  /api/status
 *   GET  /api/export?fmt=vcd|csv[&changes=0|1][&names=a,b,...][&channels=0-3,6]
 *
 * WebSocket /ws
 *   client -> server (text): {"type":"query","id":N,"t0":A,"t1":B,"width":W}
 *   server -> client (binary, little endian):
 *       u32 id, u8 mode, u8 reserved, u16 width, u64 t0, u64 t1, payload
 *     mode 0: payload = raw samples [t0, t1)
 *     mode 1: payload = u16 per pixel, bit 2c = CH c high seen, 2c+1 = low seen
 *   server -> client (text): {"type":"status", ...} on every state change
 */
#include "server.h"
#include "export.h"
#include "json.h"
#include "platform.h"
#include "util.h"

#include "civetweb.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct {
    const char *path;
    const char *mime;
    const unsigned char *data;
    size_t len;
} wp_asset;

extern const wp_asset wp_assets[];

#define MAX_WS_CLIENTS 16   /* each WebSocket holds one CivetWeb worker thread */
#define MAX_QUERY_WIDTH 8192
#define WS_HEADER_LEN 24

struct wp_server {
    struct mg_context *ctx;
    wp_engine *engine;
    const char *version;

    pthread_mutex_t ws_lock;
    struct mg_connection *ws[MAX_WS_CLIENTS];
    int nws;

    pthread_t status_thread;
    atomic_int quit;
};

/* ---- helpers ---------------------------------------------------------- */

static const char *status_text(int code)
{
    switch (code) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 409: return "Conflict";
    case 413: return "Payload Too Large";
    default:  return "Error";
    }
}

static int send_json(struct mg_connection *conn, int code, const char *body)
{
    mg_printf(conn,
              "HTTP/1.1 %d %s\r\n"
              "Content-Type: application/json\r\n"
              "Content-Length: %zu\r\n"
              "Cache-Control: no-store\r\n"
              "\r\n",
              code, status_text(code), strlen(body));
    mg_write(conn, body, strlen(body));
    return code;
}

static int send_error(struct mg_connection *conn, int code, const char *msg)
{
    char esc[256], body[320];
    wp_json_escape(msg, esc, sizeof(esc));
    snprintf(body, sizeof(body), "{\"ok\":false,\"error\":\"%s\"}", esc);
    return send_json(conn, code, body);
}

static size_t status_json(wp_server *s, char *out, size_t len)
{
    wp_capture_status st;
    wp_store *store;
    char esc[320];
    size_t n;

    wp_engine_status(s->engine, &st);
    wp_json_escape(st.error, esc, sizeof(esc));
    n = (size_t)snprintf(out, len,
        "{\"type\":\"status\",\"state\":\"%s\",\"seq\":%u,\"rate\":%llu,"
        "\"samples\":%llu,\"filled\":%llu,\"trigger_pos\":%lld,\"trigger\":\"%s\","
        "\"elapsed_ms\":%llu,\"error\":\"%s\",\"capture\":",
        wp_state_name(st.state), st.seq, (unsigned long long)st.rate,
        (unsigned long long)st.samples, (unsigned long long)st.filled,
        (long long)st.trigger_pos, st.trigger, (unsigned long long)st.elapsed_ms, esc);
    if (n >= len)
        return len - 1;
    store = wp_engine_store(s->engine);
    if (store) {
        n += (size_t)snprintf(out + n, len - n,
            "{\"n\":%llu,\"rate\":%llu,\"trigger_pos\":%lld}}",
            (unsigned long long)store->n, (unsigned long long)store->rate,
            (long long)store->trigger_pos);
        wp_store_unref(store);
    } else {
        n += (size_t)snprintf(out + n, len - n, "null}");
    }
    return n < len ? n : len - 1;
}

/* ---- REST ------------------------------------------------------------- */

static int api_device(struct mg_connection *conn, wp_server *s)
{
    wp_device_info info;
    char body[2048], model[160], fw[64];
    size_t n, i;
    wp_device *dev = wp_engine_device(s->engine);

    dev->ops->info(dev, &info);
    wp_json_escape(info.model, model, sizeof(model));
    wp_json_escape(info.firmware, fw, sizeof(fw));
    n = (size_t)snprintf(body, sizeof(body),
        "{\"backend\":\"%s\",\"model\":\"%s\",\"firmware\":\"%s\",\"channels\":8,"
        "\"version\":\"%s\",\"max_samples\":%llu,\"rates\":[",
        info.backend, model, fw, s->version,
        (unsigned long long)wp_engine_max_samples(s->engine));
    for (i = 0; i < info.nrates && n < sizeof(body) - 32; i++)
        n += (size_t)snprintf(body + n, sizeof(body) - n, "%s%llu", i ? "," : "",
                              (unsigned long long)info.rates[i]);
    snprintf(body + n, sizeof(body) - n, "]}");
    return send_json(conn, 200, body);
}

static int api_capture(struct mg_connection *conn, wp_server *s)
{
    char body[4096], err[200];
    int len = 0, r;
    double v;
    wp_capture_cfg cfg;

    while (len < (int)sizeof(body) - 1 &&
           (r = mg_read(conn, body + len, sizeof(body) - 1 - (size_t)len)) > 0)
        len += r;
    body[len] = '\0';

    memset(&cfg, 0, sizeof(cfg));
    if (wp_json_num(body, (size_t)len, "rate", &v) < 0 || v <= 0)
        return send_error(conn, 400, "missing \"rate\"");
    cfg.rate = (uint64_t)(v + 0.5);
    if (wp_json_num(body, (size_t)len, "samples", &v) < 0 || v <= 0)
        return send_error(conn, 400, "missing \"samples\"");
    cfg.samples = (uint64_t)(v + 0.5);
    if (wp_json_num(body, (size_t)len, "pre", &v) == 0)
        cfg.pre_ratio = v;
    if (wp_json_num(body, (size_t)len, "timeout_ms", &v) == 0 && v > 0)
        cfg.timeout_ms = v > 4e9 ? 4000000000u : (uint32_t)v;
    if (wp_json_str(body, (size_t)len, "trigger", cfg.trigger, sizeof(cfg.trigger)) < 0)
        cfg.trigger[0] = '\0';

    if (wp_engine_start(s->engine, &cfg, err, sizeof(err)) < 0)
        return send_error(conn, wp_engine_busy(s->engine) ? 409 : 400, err);
    return send_json(conn, 200, "{\"ok\":true}");
}

typedef struct {
    struct mg_connection *conn;
} http_writer;

static int http_write(void *ctx, const void *data, size_t len)
{
    http_writer *w = ctx;
    return mg_write(w->conn, data, len) == (int)len ? 0 : -1;
}

static int api_export(struct mg_connection *conn, wp_server *s,
                      const struct mg_request_info *ri)
{
    const char *qs = ri->query_string ? ri->query_string : "";
    size_t qlen = strlen(qs);
    char fmt[8] = "vcd", changes[4] = "1", names_buf[512], chans[40], fname[64];
    unsigned mask = WP_ALL_CHANNELS;
    char *names[8] = { 0 };
    const char *mime;
    wp_store *store;
    http_writer w = { conn };
    time_t now = time(NULL);
    struct tm tmv;
    int i;

    mg_get_var(qs, qlen, "fmt", fmt, sizeof(fmt));
    mg_get_var(qs, qlen, "changes", changes, sizeof(changes));
    if (mg_get_var(qs, qlen, "names", names_buf, sizeof(names_buf)) > 0) {
        char *p = names_buf;
        for (i = 0; i < 8 && p; i++) {
            char *comma = strchr(p, ',');
            if (comma)
                *comma = '\0';
            names[i] = p;
            p = comma ? comma + 1 : NULL;
        }
    }
    if (strcmp(fmt, "vcd") != 0 && strcmp(fmt, "csv") != 0)
        return send_error(conn, 400, "fmt must be vcd or csv");
    if (mg_get_var(qs, qlen, "channels", chans, sizeof(chans)) >= 0 &&
        wp_parse_channels(chans, &mask) < 0)
        return send_error(conn, 400, "channels must be a list such as 0-3,6");

    store = wp_engine_store(s->engine);
    if (!store)
        return send_error(conn, 404, "no completed capture");

#ifdef _WIN32
    localtime_s(&tmv, &now);
#else
    localtime_r(&now, &tmv);
#endif
    strftime(fname, sizeof(fname), "webpulse-%Y%m%d-%H%M%S", &tmv);
    mime = fmt[0] == 'v' ? "text/plain" : "text/csv";
    mg_printf(conn,
              "HTTP/1.1 200 OK\r\n"
              "Content-Type: %s; charset=utf-8\r\n"
              "Content-Disposition: attachment; filename=\"%s.%s\"\r\n"
              "Cache-Control: no-store\r\n"
              "Connection: close\r\n"
              "\r\n",
              mime, fname, fmt);
    if (fmt[0] == 'v')
        wp_export_vcd(store, (const char *const *)names, mask, http_write, &w);
    else
        wp_export_csv(store, (const char *const *)names, mask, changes[0] != '0',
                      http_write, &w);
    wp_store_unref(store);
    return 200;
}

static int api_handler(struct mg_connection *conn, void *cbdata)
{
    wp_server *s = cbdata;
    const struct mg_request_info *ri = mg_get_request_info(conn);
    const char *uri = ri->local_uri;
    int is_get = strcmp(ri->request_method, "GET") == 0;
    int is_post = strcmp(ri->request_method, "POST") == 0;

    if (strcmp(uri, "/api/device") == 0)
        return is_get ? api_device(conn, s) : send_error(conn, 405, "use GET");
    if (strcmp(uri, "/api/status") == 0) {
        char body[1024];
        if (!is_get)
            return send_error(conn, 405, "use GET");
        status_json(s, body, sizeof(body));
        return send_json(conn, 200, body);
    }
    if (strcmp(uri, "/api/capture") == 0)
        return is_post ? api_capture(conn, s) : send_error(conn, 405, "use POST");
    if (strcmp(uri, "/api/stop") == 0) {
        if (!is_post)
            return send_error(conn, 405, "use POST");
        wp_engine_stop(s->engine);
        return send_json(conn, 200, "{\"ok\":true}");
    }
    if (strcmp(uri, "/api/export") == 0)
        return is_get ? api_export(conn, s, ri) : send_error(conn, 405, "use GET");
    return send_error(conn, 404, "unknown API endpoint");
}

/* ---- embedded static files ---------------------------------------------- */

static int asset_handler(struct mg_connection *conn, void *cbdata)
{
    const struct mg_request_info *ri = mg_get_request_info(conn);
    const char *uri = ri->local_uri;
    const wp_asset *a;
    (void)cbdata;

    if (strcmp(uri, "/") == 0)
        uri = "/index.html";
    for (a = wp_assets; a->path; a++) {
        if (strcmp(a->path, uri) == 0) {
            mg_printf(conn,
                      "HTTP/1.1 200 OK\r\n"
                      "Content-Type: %s\r\n"
                      "Content-Length: %zu\r\n"
                      "Cache-Control: no-cache\r\n"
                      "\r\n",
                      a->mime, a->len);
            if (strcmp(ri->request_method, "HEAD") != 0)
                mg_write(conn, a->data, a->len);
            return 200;
        }
    }
    mg_printf(conn,
              "HTTP/1.1 404 Not Found\r\n"
              "Content-Type: text/plain\r\n"
              "Content-Length: 10\r\n"
              "\r\n"
              "not found\n");
    return 404;
}

/* ---- WebSocket ---------------------------------------------------------- */

static void put_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static void put_u32(uint8_t *p, uint32_t v)
{
    put_u16(p, (uint16_t)v);
    put_u16(p + 2, (uint16_t)(v >> 16));
}

static void put_u64(uint8_t *p, uint64_t v)
{
    put_u32(p, (uint32_t)v);
    put_u32(p + 4, (uint32_t)(v >> 32));
}

static void ws_send_text(struct mg_connection *conn, const char *text)
{
    mg_websocket_write(conn, MG_WEBSOCKET_OPCODE_TEXT, text, strlen(text));
}

static void ws_query(wp_server *s, struct mg_connection *conn, const char *js, size_t len)
{
    double id = 0, t0 = 0, t1 = 0, width = 0;
    wp_store *store;
    uint8_t *msg, mode;
    uint64_t a, b, b_out;
    uint32_t w;
    size_t plen;

    wp_json_num(js, len, "id", &id);
    if (wp_json_num(js, len, "t0", &t0) < 0 || wp_json_num(js, len, "t1", &t1) < 0 ||
        wp_json_num(js, len, "width", &width) < 0) {
        ws_send_text(conn, "{\"type\":\"error\",\"error\":\"query needs t0, t1, width\"}");
        return;
    }
    store = wp_engine_store(s->engine);
    if (!store) {
        char e[96];
        snprintf(e, sizeof(e), "{\"type\":\"error\",\"id\":%.0f,\"error\":\"no capture\"}", id);
        ws_send_text(conn, e);
        return;
    }
    a = t0 > 0 ? (uint64_t)t0 : 0;
    b = t1 > 0 ? (uint64_t)t1 : 0;
    w = width < 1 ? 1 : width > MAX_QUERY_WIDTH ? MAX_QUERY_WIDTH : (uint32_t)width;

    msg = malloc(WS_HEADER_LEN + wp_store_query_max(w));
    if (msg) {
        plen = wp_store_query(store, a, b, w, msg + WS_HEADER_LEN, wp_store_query_max(w),
                              &mode, &b_out);
        if (a > b_out)
            a = b_out;
        put_u32(msg, (uint32_t)id);
        msg[4] = mode;
        msg[5] = 0;
        put_u16(msg + 6, (uint16_t)(mode == WP_QUERY_SUMMARY ? plen / 2 : 0));
        put_u64(msg + 8, a);
        put_u64(msg + 16, b_out);
        mg_websocket_write(conn, MG_WEBSOCKET_OPCODE_BINARY, (const char *)msg,
                           WS_HEADER_LEN + plen);
        free(msg);
    }
    wp_store_unref(store);
}

static int ws_connect(const struct mg_connection *conn, void *cbdata)
{
    wp_server *s = cbdata;
    int ok;
    (void)conn;
    pthread_mutex_lock(&s->ws_lock);
    ok = s->nws < MAX_WS_CLIENTS;
    pthread_mutex_unlock(&s->ws_lock);
    return ok ? 0 : 1;      /* non-zero rejects */
}

static void ws_ready(struct mg_connection *conn, void *cbdata)
{
    wp_server *s = cbdata;
    char st[1024];

    status_json(s, st, sizeof(st));
    pthread_mutex_lock(&s->ws_lock);
    if (s->nws < MAX_WS_CLIENTS)
        s->ws[s->nws++] = conn;
    ws_send_text(conn, st);
    pthread_mutex_unlock(&s->ws_lock);
}

static int ws_data(struct mg_connection *conn, int bits, char *data, size_t len, void *cbdata)
{
    wp_server *s = cbdata;
    int opcode = bits & 0x0f;
    char type[16];

    if (opcode == MG_WEBSOCKET_OPCODE_CONNECTION_CLOSE)
        return 0;
    if (opcode != MG_WEBSOCKET_OPCODE_TEXT)
        return 1;
    if (wp_json_str(data, len, "type", type, sizeof(type)) < 0)
        return 1;
    if (strcmp(type, "query") == 0) {
        ws_query(s, conn, data, len);
    } else if (strcmp(type, "status") == 0) {
        char st[1024];
        status_json(s, st, sizeof(st));
        ws_send_text(conn, st);
    }
    return 1;
}

static void ws_close(const struct mg_connection *conn, void *cbdata)
{
    wp_server *s = cbdata;
    int i;
    pthread_mutex_lock(&s->ws_lock);
    for (i = 0; i < s->nws; i++) {
        if (s->ws[i] == conn) {
            s->ws[i] = s->ws[--s->nws];
            break;
        }
    }
    pthread_mutex_unlock(&s->ws_lock);
}

/* Push status to all WebSocket clients when it changes (and every 250 ms
 * while a capture is running so progress bars move). */
static void *status_main(void *arg)
{
    wp_server *s = arg;
    uint32_t last_seq = 0;
    uint64_t last_push = 0;
    char st[1024];

    while (!atomic_load(&s->quit)) {
        wp_capture_status cs;
        uint64_t now = wp_now_ms();
        int running;

        wp_engine_status(s->engine, &cs);
        running = cs.state == WP_ST_ARMED || cs.state == WP_ST_CAPTURING ||
                  cs.state == WP_ST_PROCESSING;
        if (cs.seq != last_seq || (running && now - last_push >= 250)) {
            int i;
            last_seq = cs.seq;
            last_push = now;
            status_json(s, st, sizeof(st));
            pthread_mutex_lock(&s->ws_lock);
            for (i = 0; i < s->nws; i++)
                ws_send_text(s->ws[i], st);
            pthread_mutex_unlock(&s->ws_lock);
        }
        wp_sleep_ms(20);
    }
    return NULL;
}

/* ---- lifecycle ------------------------------------------------------------ */

wp_server *wp_server_start(wp_engine *e, const wp_server_opts *o, char *err, size_t errlen)
{
    wp_server *s = calloc(1, sizeof(*s));
    char ports[80];
    const char *opts[16];
    int n = 0;
    struct mg_callbacks cb;
    struct mg_init_data init;
    struct mg_error_data errd;
    char errbuf[256] = "";

    if (!s) {
        snprintf(err, errlen, "out of memory");
        return NULL;
    }
    s->engine = e;
    s->version = o->version ? o->version : "";
    pthread_mutex_init(&s->ws_lock, NULL);
    atomic_init(&s->quit, 0);

    snprintf(ports, sizeof(ports), "%s:%d", o->listen ? o->listen : "127.0.0.1", o->port);
    opts[n++] = "listening_ports";
    opts[n++] = ports;
    opts[n++] = "num_threads";
    opts[n++] = "32";
    opts[n++] = "enable_directory_listing";
    opts[n++] = "no";
    opts[n++] = "websocket_timeout_ms";
    opts[n++] = "3600000";
    /* Viewport replies are small; without this, Nagle + delayed ACK adds
     * ~40 ms to every query. */
    opts[n++] = "tcp_nodelay";
    opts[n++] = "1";
    if (o->web_root) {
        opts[n++] = "document_root";
        opts[n++] = o->web_root;
    }
    opts[n] = NULL;

    memset(&cb, 0, sizeof(cb));
    memset(&init, 0, sizeof(init));
    init.callbacks = &cb;
    init.user_data = s;
    init.configuration_options = opts;
    memset(&errd, 0, sizeof(errd));
    errd.text = errbuf;
    errd.text_buffer_size = sizeof(errbuf);

    mg_init_library(0);
    s->ctx = mg_start2(&init, &errd);
    if (!s->ctx) {
        snprintf(err, errlen, "cannot start HTTP server on %s: %s", ports,
                 errbuf[0] ? errbuf : "unknown error");
        mg_exit_library();
        pthread_mutex_destroy(&s->ws_lock);
        free(s);
        return NULL;
    }

    mg_set_request_handler(s->ctx, "/api", api_handler, s);
    mg_set_websocket_handler(s->ctx, "/ws", ws_connect, ws_ready, ws_data, ws_close, s);
    if (!o->web_root)
        mg_set_request_handler(s->ctx, "**", asset_handler, NULL);

    if (pthread_create(&s->status_thread, NULL, status_main, s) != 0) {
        snprintf(err, errlen, "cannot create status thread");
        mg_stop(s->ctx);
        mg_exit_library();
        pthread_mutex_destroy(&s->ws_lock);
        free(s);
        return NULL;
    }
    return s;
}

void wp_server_stop(wp_server *s)
{
    if (!s)
        return;
    atomic_store(&s->quit, 1);
    pthread_join(s->status_thread, NULL);
    mg_stop(s->ctx);
    mg_exit_library();
    pthread_mutex_destroy(&s->ws_lock);
    free(s);
}
