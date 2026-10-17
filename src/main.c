/*
 * webpulse - 8-channel logic analyzer server (WebPulse)
 *
 * Server mode (default): HTTP + WebSocket UI on --listen:--port.
 * One-shot mode (--capture): capture once and write a VCD / CSV file.
 */
#include "capture.h"
#include "device.h"
#include "export.h"
#include "platform.h"
#include "server.h"
#include "sr.h"
#include "util.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <spawn.h>
#include <unistd.h>
extern char **environ;
#endif

#ifndef WP_VERSION
#define WP_VERSION "dev"
#endif

static volatile sig_atomic_t g_quit;

static void on_signal(int sig)
{
    (void)sig;
    g_quit = 1;
}

typedef struct {
    const char *backend;
    const char *listen;
    int port;
    int port_set;               /* given with -p: do not fall back to another port */
    const char *web_root;
    const char *firmware;
    const char *decoders;
    const char *token;
    int no_auth;
    int no_browser;             /* do not open the UI in the default browser */
    double sim_speed;
    uint64_t max_samples;

    int capture;
    uint64_t rate;
    uint64_t samples;
    const char *trigger;
    double pre_pct;
    uint32_t timeout_ms;
    const char *output;
    const char *open;           /* .sr file to load */
    unsigned channels;          /* channel mask for the output file */
    int list_rates;
} options;

static void usage(FILE *f)
{
    fprintf(f,
        "WebPulse %s - 8-channel logic analyzer server\n"
        "\n"
        "Usage: webpulse [options]\n"
        "\n"
        "Server:\n"
        "  -b, --backend sim|fx2    device backend (default: %s)\n"
        "  -l, --listen ADDR        bind address (default 127.0.0.1, 0.0.0.0 = all)\n"
        "      --token TOKEN        access token for other computers (default: a random\n"
        "                           one when --listen is not local; it is printed)\n"
        "      --no-auth            no access token, anyone who can reach the port may use it\n"
        "      --no-browser         do not open the UI in the default web browser\n"
        "                           (it is opened once started; on Linux only with a desktop)\n"
        "  -p, --port N             HTTP port (default 9002; if it is taken and -p is\n"
        "                           not given, the next free one up to 9011)\n"
        "  -w, --web-root DIR       serve the UI from DIR instead of the embedded copy\n"
        "  -d, --decoders DIR       folder with your own protocol decoders (*.js)\n"
        "                           (default: decoders/ next to the exe)\n"
        "  -f, --firmware PATH      fx2lafw firmware image\n"
        "                           (default: firmware/fx2lafw-saleae-logic.fw next to the exe)\n"
        "      --sim-speed X        simulator speed, 1 = real time, 0 = unlimited (default 1)\n"
        "      --max-samples N      largest allowed capture (default 256M)\n"
        "\n"
        "One-shot capture (no server):\n"
        "  -c, --capture            capture once, write --output, exit\n"
        "  -r, --rate R             sample rate, e.g. 24M (default 24M)\n"
        "  -n, --samples N          samples to capture, e.g. 10M (default 1M)\n"
        "  -t, --trigger SPEC       8 chars of X/0/1/R/F/E, char i = CH i (default none)\n"
        "      --pre PCT            pre-trigger percentage 0..100 (default 10)\n"
        "      --timeout MS         trigger timeout in ms, 0 = forever (default 0)\n"
        "  -o, --output FILE        output file: .vcd, .csv or .sr (sigrok / PulseView)\n"
        "      --channels LIST      channels to write, e.g. 0-3,6 (default 0-7)\n"
        "\n"
        "\n"
        "      --open FILE.sr       load a sigrok session file: with -o, convert it\n"
        "                           and exit; otherwise show it in the UI\n"
        "  -L, --list-rates         list supported sample rates\n"
        "  -V, --version\n"
        "  -h, --help\n",
        WP_VERSION,
#ifdef WP_HAVE_FX2
        "fx2"
#else
        "sim (fx2 not built)"
#endif
    );
}

static int need_arg(int argc, char **argv, int *i, const char **out)
{
    if (*i + 1 >= argc) {
        fprintf(stderr, "webpulse: %s needs an argument\n", argv[*i]);
        return -1;
    }
    *out = argv[++*i];
    return 0;
}

static int parse_args(int argc, char **argv, options *o)
{
    int i;
    for (i = 1; i < argc; i++) {
        const char *a = argv[i], *v;
#define IS(s, l) (strcmp(a, s) == 0 || strcmp(a, l) == 0)
        if (IS("-h", "--help")) {
            usage(stdout);
            exit(0);
        } else if (IS("-V", "--version")) {
            printf("webpulse %s\n", WP_VERSION);
            exit(0);
        } else if (IS("-b", "--backend")) {
            if (need_arg(argc, argv, &i, &o->backend)) return -1;
        } else if (IS("-l", "--listen")) {
            if (need_arg(argc, argv, &i, &o->listen)) return -1;
        } else if (IS("-p", "--port")) {
            if (need_arg(argc, argv, &i, &v)) return -1;
            o->port = atoi(v);
            o->port_set = 1;
            if (o->port <= 0 || o->port > 65535) {
                fprintf(stderr, "webpulse: invalid port %s\n", v);
                return -1;
            }
        } else if (IS("-w", "--web-root")) {
            if (need_arg(argc, argv, &i, &o->web_root)) return -1;
        } else if (strcmp(a, "--token") == 0) {
            if (need_arg(argc, argv, &i, &o->token)) return -1;
        } else if (strcmp(a, "--browser") == 0) {
            o->no_browser = 0;          /* the default since 0.2.2; kept for old shortcuts */
        } else if (strcmp(a, "--no-browser") == 0) {
            o->no_browser = 1;
        } else if (strcmp(a, "--no-auth") == 0) {
            o->no_auth = 1;
        } else if (IS("-d", "--decoders")) {
            if (need_arg(argc, argv, &i, &o->decoders)) return -1;
        } else if (IS("-f", "--firmware")) {
            if (need_arg(argc, argv, &i, &o->firmware)) return -1;
        } else if (strcmp(a, "--sim-speed") == 0) {
            if (need_arg(argc, argv, &i, &v)) return -1;
            o->sim_speed = atof(v);
        } else if (strcmp(a, "--max-samples") == 0) {
            if (need_arg(argc, argv, &i, &v) || wp_parse_si(v, &o->max_samples) < 0) {
                fprintf(stderr, "webpulse: invalid --max-samples\n");
                return -1;
            }
        } else if (IS("-c", "--capture")) {
            o->capture = 1;
        } else if (IS("-r", "--rate")) {
            if (need_arg(argc, argv, &i, &v) || wp_parse_si(v, &o->rate) < 0) {
                fprintf(stderr, "webpulse: invalid --rate\n");
                return -1;
            }
        } else if (IS("-n", "--samples")) {
            if (need_arg(argc, argv, &i, &v) || wp_parse_si(v, &o->samples) < 0) {
                fprintf(stderr, "webpulse: invalid --samples\n");
                return -1;
            }
        } else if (IS("-t", "--trigger")) {
            if (need_arg(argc, argv, &i, &o->trigger)) return -1;
        } else if (strcmp(a, "--pre") == 0) {
            if (need_arg(argc, argv, &i, &v)) return -1;
            o->pre_pct = atof(v);
        } else if (strcmp(a, "--timeout") == 0) {
            if (need_arg(argc, argv, &i, &v)) return -1;
            o->timeout_ms = (uint32_t)strtoul(v, NULL, 10);
        } else if (strcmp(a, "--open") == 0) {
            if (need_arg(argc, argv, &i, &o->open)) return -1;
        } else if (IS("-o", "--output")) {
            if (need_arg(argc, argv, &i, &o->output)) return -1;
        } else if (strcmp(a, "--channels") == 0) {
            if (need_arg(argc, argv, &i, &v)) return -1;
            if (wp_parse_channels(v, &o->channels) < 0) {
                fprintf(stderr, "webpulse: bad --channels \"%s\" (e.g. 0-3,6)\n", v);
                return -1;
            }
        } else if (IS("-L", "--list-rates")) {
            o->list_rates = 1;
        } else {
            fprintf(stderr, "webpulse: unknown option %s (see --help)\n", a);
            return -1;
        }
#undef IS
    }
    return 0;
}

/* Directory containing the executable, with trailing separator. */
static void exe_dir(char *buf, size_t len)
{
    size_t n = 0;
    buf[0] = '\0';
#ifdef _WIN32
    n = GetModuleFileNameA(NULL, buf, (DWORD)len);
    if (n == 0 || n >= len) {
        buf[0] = '\0';
        return;
    }
    while (n > 0 && buf[n - 1] != '\\' && buf[n - 1] != '/')
        n--;
#else
    ssize_t r = readlink("/proc/self/exe", buf, len - 1);
    if (r <= 0) {
        buf[0] = '\0';
        return;
    }
    n = (size_t)r;
    while (n > 0 && buf[n - 1] != '/')
        n--;
#endif
    buf[n] = '\0';
}

static wp_device *make_device(const options *o, char *fw_path, size_t fw_len)
{
    if (strcmp(o->backend, "sim") == 0)
        return wp_sim_new(o->sim_speed);
    if (strcmp(o->backend, "fx2") == 0) {
#ifdef WP_HAVE_FX2
        if (o->firmware) {
            wp_strlcpy(fw_path, o->firmware, fw_len);
        } else {
            exe_dir(fw_path, fw_len);
            strncat(fw_path, "firmware/fx2lafw-saleae-logic.fw",
                    fw_len - strlen(fw_path) - 1);
        }
        return wp_fx2_new(fw_path);
#else
        (void)fw_path; (void)fw_len;
        fprintf(stderr, "webpulse: this build has no fx2 backend (libusb not found at "
                        "build time); use --backend sim\n");
        return NULL;
#endif
    }
    fprintf(stderr, "webpulse: unknown backend '%s'\n", o->backend);
    return NULL;
}

static const char *ext_of(const char *path)
{
    const char *dot = strrchr(path, '.');
    return dot ? dot + 1 : "";
}

/* Output format from the file name: 'v' (VCD), 'c' (CSV), 's' (sigrok .sr) or 0. */
static int output_kind(const char *path)
{
    const char *x = ext_of(path);
    return strcmp(x, "vcd") == 0 ? 'v' : strcmp(x, "csv") == 0 ? 'c' : strcmp(x, "sr") == 0 ? 's' : 0;
}

static int write_output(const wp_store *store, const options *o, const char *const *names)
{
    FILE *f = fopen(o->output, "wb");
    int kind = output_kind(o->output), rc;
    if (!f) {
        perror(o->output);
        return 1;
    }
    rc = kind == 'c' ? wp_export_csv(store, names, o->channels, 1, wp_write_file, f)
       : kind == 's' ? wp_sr_write(store, names, o->channels, wp_write_file, f)
                     : wp_export_vcd(store, names, o->channels, wp_write_file, f);
    if (fclose(f) != 0)
        rc = -1;
    if (rc == 0) {
        fprintf(stderr, "wrote %s (%llu samples", o->output, (unsigned long long)store->n);
        if (store->trigger_pos >= 0)
            fprintf(stderr, ", trigger at sample %lld", (long long)store->trigger_pos);
        fprintf(stderr, ")\n");
    } else {
        fprintf(stderr, "webpulse: error writing %s\n", o->output);
    }
    return rc == 0 ? 0 : 1;
}

/* Read a whole .sr file and parse it. */
static int load_sr(const char *path, uint64_t max_samples, wp_sr_capture *c)
{
    FILE *f = fopen(path, "rb");
    uint8_t *buf = NULL;
    long len;
    char err[200];
    int rc = -1;

    if (!f) {
        perror(path);
        return -1;
    }
    if (fseek(f, 0, SEEK_END) == 0 && (len = ftell(f)) > 0 && fseek(f, 0, SEEK_SET) == 0 &&
        (buf = malloc((size_t)len)) && fread(buf, 1, (size_t)len, f) == (size_t)len) {
        rc = wp_sr_read(buf, (size_t)len, max_samples, c, err, sizeof(err));
        if (rc < 0)
            fprintf(stderr, "webpulse: %s: %s\n", path, err);
        else if (c->note[0])
            fprintf(stderr, "webpulse: %s: %s\n", path, c->note);
    } else {
        fprintf(stderr, "webpulse: cannot read %s\n", path);
    }
    free(buf);
    fclose(f);
    return rc;
}

/* --open FILE.sr -o OUT: convert without a device. */
static int run_convert(const options *o)
{
    wp_sr_capture c;
    const char *names[8];
    wp_store *store;
    int i, rc;

    if (load_sr(o->open, UINT64_MAX, &c) < 0)
        return 1;
    for (i = 0; i < 8; i++)
        names[i] = c.names[i][0] ? c.names[i] : NULL;
    store = wp_store_new(c.raw, c.n, c.rate, c.trigger_pos);
    if (!store) {
        fprintf(stderr, "webpulse: out of memory\n");
        return 1;
    }
    rc = write_output(store, o, names);
    wp_store_unref(store);
    return rc;
}

static int run_capture(wp_engine *e, const options *o)
{
    wp_capture_cfg cfg;
    wp_capture_status st;
    wp_store *store;
    char err[200], rate_str[32];
    int rc;
    uint64_t last = 0;

    memset(&cfg, 0, sizeof(cfg));
    cfg.rate = o->rate;
    cfg.samples = o->samples;
    cfg.pre_ratio = o->pre_pct / 100.0;
    cfg.timeout_ms = o->timeout_ms;
    if (o->trigger)
        wp_strlcpy(cfg.trigger, o->trigger, sizeof(cfg.trigger));

    if (wp_engine_start(e, &cfg, err, sizeof(err)) < 0) {
        fprintf(stderr, "webpulse: %s\n", err);
        return 1;
    }
    wp_format_rate(cfg.rate, rate_str, sizeof(rate_str));
    fprintf(stderr, "capturing %llu samples at %s%s%s\n", (unsigned long long)cfg.samples,
            rate_str, cfg.trigger[0] ? ", trigger " : "", cfg.trigger);

    while (wp_engine_busy(e)) {
        if (g_quit) {
            wp_engine_stop(e);
            g_quit = 0;
        }
        if (wp_now_ms() - last >= 250) {
            last = wp_now_ms();
            wp_engine_status(e, &st);
            fprintf(stderr, "\r  %-10s %5.1f %%", wp_state_name(st.state),
                    st.samples ? 100.0 * (double)st.filled / (double)st.samples : 0.0);
            fflush(stderr);
        }
        wp_sleep_ms(10);
    }
    wp_engine_status(e, &st);
    fprintf(stderr, "\r  %-10s\n", wp_state_name(st.state));
    if (st.state != WP_ST_DONE) {
        fprintf(stderr, "webpulse: capture failed: %s\n",
                st.error[0] ? st.error : "stopped before trigger");
        return 1;
    }
    if (st.error[0])
        fprintf(stderr, "webpulse: warning: %s\n", st.error);

    store = wp_engine_store(e);
    rc = write_output(store, o, NULL);
    wp_store_unref(store);
    return rc;
}

/* Whether there is a desktop to open a browser on: always on Windows; on
 * Linux only with an X11 or Wayland session (not on a server or in a
 * container, where trying would only print a warning). */
static int have_desktop(void)
{
#ifdef _WIN32
    return 1;
#else
    const char *x = getenv("DISPLAY"), *w = getenv("WAYLAND_DISPLAY");
    return (x && *x) || (w && *w);
#endif
}

/* Open url in the default browser; failures only print a note. */
static void open_browser(const char *url)
{
#ifdef _WIN32
    if ((INT_PTR)ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL) <= 32)
        fprintf(stderr, "webpulse: could not open a browser; open %s yourself\n", url);
#else
    /* xdg-open, without a shell, its output discarded; not waited for. */
    char *argv[] = { "xdg-open", (char *)url, NULL };
    posix_spawn_file_actions_t fa;
    pid_t pid;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
    if (posix_spawnp(&pid, "xdg-open", &fa, NULL, argv, environ) != 0)
        fprintf(stderr, "webpulse: could not run xdg-open; open %s yourself\n", url);
    posix_spawn_file_actions_destroy(&fa);
    signal(SIGCHLD, SIG_IGN);           /* no zombie once it exits */
#endif
}

static int is_local_addr(const char *a)
{
    return strncmp(a, "127.", 4) == 0 || strcmp(a, "localhost") == 0 || strcmp(a, "::1") == 0;
}

static int run_server(wp_engine *e, const options *o)
{
    wp_server_opts so;
    wp_server *srv;
    char err[300], dec_dir[1024], token[72] = "";

    memset(&so, 0, sizeof(so));
    so.listen = o->listen;
    so.port = o->port;
    so.port_tries = o->port_set ? 1 : 10;   /* default port taken: try 9003..9011 */
    so.web_root = o->web_root;
    so.version = WP_VERSION;
    if (o->decoders) {
        wp_strlcpy(dec_dir, o->decoders, sizeof(dec_dir));
    } else {
        exe_dir(dec_dir, sizeof(dec_dir));
        strncat(dec_dir, "decoders", sizeof(dec_dir) - strlen(dec_dir) - 1);
    }
    so.decoders_dir = dec_dir;

    /* Other machines need a token unless told otherwise; this machine never does. */
    if (o->token) {
        if (strlen(o->token) < 8 || strlen(o->token) > 64) {
            fprintf(stderr, "webpulse: --token must be 8..64 characters\n");
            return 2;
        }
        wp_strlcpy(token, o->token, sizeof(token));
    } else if (!o->no_auth && !is_local_addr(o->listen)) {
        uint8_t r[16];
        int i;
        if (wp_random_bytes(r, sizeof(r)) != 0) {
            fprintf(stderr, "webpulse: cannot create an access token (use --token or --no-auth)\n");
            return 1;
        }
        for (i = 0; i < 16; i++)
            snprintf(token + 2 * i, 3, "%02x", r[i]);
    }
    so.token = token[0] ? token : NULL;

    srv = wp_server_start(e, &so, err, sizeof(err));
    if (!srv) {
        fprintf(stderr, "webpulse: %s\n", err);
        return 1;
    }
    if (is_local_addr(o->listen)) {
        fprintf(stderr, "WebPulse %s listening on http://%s:%d/  (Ctrl+C to quit)\n",
                WP_VERSION, strcmp(o->listen, "localhost") == 0 ? "localhost" : o->listen,
                wp_server_port(srv));
    } else {
        const char *host = strcmp(o->listen, "0.0.0.0") == 0 || strcmp(o->listen, "::") == 0
                         ? "<this-computer>" : o->listen;
        fprintf(stderr, "WebPulse %s listening on port %d  (Ctrl+C to quit)\n"
                        "  on this computer:  http://localhost:%d/\n",
                WP_VERSION, wp_server_port(srv), wp_server_port(srv));
        if (token[0])
            fprintf(stderr, "  from elsewhere:    http://%s:%d/?token=%s\n", host,
                    wp_server_port(srv), token);
        else
            fprintf(stderr, "  from elsewhere:    http://%s:%d/  (no access token: --no-auth)\n",
                    host, wp_server_port(srv));
    }
    if (!o->no_browser && have_desktop()) {
        /* This computer never needs the token, so the local address will do. */
        char url[96];
        snprintf(url, sizeof(url), "http://%s:%d/",
                 is_local_addr(o->listen) && strcmp(o->listen, "localhost") != 0 ? o->listen : "localhost",
                 wp_server_port(srv));
        open_browser(url);
    }
    while (!g_quit)
        wp_sleep_ms(100);
    fprintf(stderr, "shutting down\n");
    wp_engine_stop(e);
    wp_engine_wait(e, 5000);
    wp_server_stop(srv);
    return 0;
}

int main(int argc, char **argv)
{
    options o;
    wp_device *dev;
    wp_engine *e;
    char err[512], fw_path[1024];
    int rc;

    memset(&o, 0, sizeof(o));
#ifdef WP_HAVE_FX2
    o.backend = "fx2";
#else
    o.backend = "sim";
#endif
    o.channels = WP_ALL_CHANNELS;
    o.listen = "127.0.0.1";
    o.port = 9002;
    o.sim_speed = 1.0;
    o.max_samples = 256000000ull;
    o.rate = 24000000;
    o.samples = 1000000;
    o.pre_pct = 10;

    if (parse_args(argc, argv, &o) < 0)
        return 2;
    if (o.pre_pct < 0 || o.pre_pct > 100) {
        fprintf(stderr, "webpulse: --pre must be within 0..100\n");
        return 2;
    }

    if (o.list_rates) {
        size_t i;
        for (i = 0; i < wp_fx2_nrates; i++) {
            char r[32];
            wp_format_rate(wp_fx2_rates[i], r, sizeof(r));
            printf("%s\n", r);
        }
        return 0;
    }

    if ((o.capture || o.open) && o.output && !output_kind(o.output)) {
        fprintf(stderr, "webpulse: output must end in .vcd, .csv or .sr\n");
        return 2;
    }
    if (o.capture && !o.output) {
        fprintf(stderr, "webpulse: --capture needs --output FILE.vcd|.csv|.sr\n");
        return 2;
    }
    if (o.capture && o.open) {
        fprintf(stderr, "webpulse: use either --capture or --open\n");
        return 2;
    }
    if (o.open && o.output)
        return run_convert(&o);

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    dev = make_device(&o, fw_path, sizeof(fw_path));
    if (!dev)
        return 1;
    if (dev->ops->open(dev, err, sizeof(err)) < 0) {
        if (o.capture) {
            fprintf(stderr, "webpulse: %s\n", err);
            wp_device_destroy(dev);
            return 1;
        }
        /* Server mode: keep running, the device is opened on the next Run. */
        fprintf(stderr, "webpulse: warning: %s (will retry when a capture starts)\n", err);
    }
    if (dev->is_open) {
        wp_device_info info;
        dev->ops->info(dev, &info);
        fprintf(stderr, "device: %s (%s)%s%s\n", info.model, info.backend,
                info.firmware[0] ? ", firmware " : "", info.firmware);
    }

    e = wp_engine_new(dev, o.max_samples);
    if (!e) {
        fprintf(stderr, "webpulse: out of memory\n");
        wp_device_destroy(dev);
        return 1;
    }

    if (o.capture) {
        /* One-shot runs the simulator flat out unless asked otherwise. */
        rc = run_capture(e, &o);
    } else {
        if (o.open) {
            wp_sr_capture c;
            char note[300];
            if (load_sr(o.open, o.max_samples, &c) < 0) {
                wp_engine_free(e);
                wp_device_destroy(dev);
                return 1;
            }
            snprintf(note, sizeof(note), "opened %s", o.open);
            if (wp_engine_load(e, c.raw, c.n, c.rate, c.trigger_pos,
                               (const char (*)[32])c.names, note, err, sizeof(err)) < 0)
                fprintf(stderr, "webpulse: %s\n", err);
        }
        rc = run_server(e, &o);
    }

    wp_engine_free(e);
    dev->ops->close(dev);
    wp_device_destroy(dev);
    return rc;
}
