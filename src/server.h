/* HTTP / WebSocket front end built on CivetWeb. */
#ifndef WP_SERVER_H
#define WP_SERVER_H

#include "capture.h"

#include <stddef.h>

typedef struct {
    const char *listen;         /* bind address, e.g. "127.0.0.1" */
    int port;
    int port_tries;             /* if port cannot be bound, also try port+1 .. port+tries-1 */
    const char *web_root;       /* NULL = serve the embedded copy of web/ */
    const char *decoders_dir;   /* user protocol decoders (*.js), may be NULL */
    const char *token;          /* access token for non-local clients, NULL = none */
    const char *version;
} wp_server_opts;

typedef struct wp_server wp_server;

wp_server *wp_server_start(wp_engine *e, const wp_server_opts *o, char *err, size_t errlen);
void wp_server_stop(wp_server *s);
int wp_server_port(const wp_server *s);     /* the port actually in use */

#endif
