/* HTTP / WebSocket front end built on CivetWeb. */
#ifndef WP_SERVER_H
#define WP_SERVER_H

#include "capture.h"

#include <stddef.h>

typedef struct {
    const char *listen;         /* bind address, e.g. "127.0.0.1" */
    int port;
    const char *web_root;       /* NULL = serve the embedded copy of web/ */
    const char *version;
} wp_server_opts;

typedef struct wp_server wp_server;

wp_server *wp_server_start(wp_engine *e, const wp_server_opts *o, char *err, size_t errlen);
void wp_server_stop(wp_server *s);

#endif
