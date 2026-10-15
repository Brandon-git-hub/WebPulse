#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Skip a JSON string starting at js[i] == '"'; returns index after it. */
static size_t skip_string(const char *js, size_t len, size_t i)
{
    for (i++; i < len; i++) {
        if (js[i] == '\\')
            i++;
        else if (js[i] == '"')
            return i + 1;
    }
    return len;
}

static size_t skip_ws(const char *js, size_t len, size_t i)
{
    while (i < len && (js[i] == ' ' || js[i] == '\t' || js[i] == '\n' || js[i] == '\r'))
        i++;
    return i;
}

/* Find the value of key at depth 1; returns its index or len if absent. */
static size_t find_value(const char *js, size_t len, const char *key)
{
    size_t i = 0, klen = strlen(key);
    int depth = 0;

    while (i < len) {
        char c = js[i];
        if (c == '"') {
            size_t s = i + 1, e = skip_string(js, len, i);
            if (depth == 1 && e - s - 1 == klen && memcmp(js + s, key, klen) == 0) {
                size_t j = skip_ws(js, len, e);
                if (j < len && js[j] == ':')
                    return skip_ws(js, len, j + 1);
            }
            i = e;
            continue;
        }
        if (c == '{' || c == '[')
            depth++;
        else if (c == '}' || c == ']')
            depth--;
        i++;
    }
    return len;
}

int wp_json_num(const char *js, size_t len, const char *key, double *out)
{
    size_t i = find_value(js, len, key);
    char tmp[64];
    size_t n = 0;
    char *end;

    if (i >= len)
        return -1;
    if (js[i] == 't' && i + 4 <= len && memcmp(js + i, "true", 4) == 0) {
        *out = 1;
        return 0;
    }
    if (js[i] == 'f' && i + 5 <= len && memcmp(js + i, "false", 5) == 0) {
        *out = 0;
        return 0;
    }
    while (i + n < len && n < sizeof(tmp) - 1 &&
           strchr("+-0123456789.eE", js[i + n]) && js[i + n])
        n++;
    if (n == 0)
        return -1;
    memcpy(tmp, js + i, n);
    tmp[n] = '\0';
    *out = strtod(tmp, &end);
    return end == tmp ? -1 : 0;
}

int wp_json_str(const char *js, size_t len, const char *key, char *out, size_t outlen)
{
    size_t i = find_value(js, len, key), o = 0;

    if (i >= len || js[i] != '"' || outlen == 0)
        return -1;
    for (i++; i < len && js[i] != '"'; i++) {
        char c = js[i];
        if (c == '\\' && i + 1 < len) {
            c = js[++i];
            switch (c) {
            case 'n': c = '\n'; break;
            case 't': c = '\t'; break;
            case 'r': c = '\r'; break;
            case 'b': c = '\b'; break;
            case 'f': c = '\f'; break;
            case 'u':   /* keep ASCII only; replace others with '?' */
                if (i + 4 < len) {
                    char hex[5] = { js[i + 1], js[i + 2], js[i + 3], js[i + 4], 0 };
                    long v = strtol(hex, NULL, 16);
                    c = (v > 0 && v < 0x80) ? (char)v : '?';
                    i += 4;
                }
                break;
            default: break;     /* \" \\ \/ */
            }
        }
        if (o + 1 < outlen)
            out[o++] = c;
    }
    out[o] = '\0';
    return i < len ? 0 : -1;
}

size_t wp_json_escape(const char *s, char *out, size_t outlen)
{
    size_t o = 0;
    if (outlen == 0)
        return 0;
    for (; *s && o + 7 < outlen; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') {
            out[o++] = '\\';
            out[o++] = (char)c;
        } else if (c < 0x20) {
            o += (size_t)snprintf(out + o, outlen - o, "\\u%04x", c);
        } else {
            out[o++] = (char)c;
        }
    }
    out[o] = '\0';
    return o;
}
