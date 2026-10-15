/* Tiny test harness: each test file has a main() that calls CHECK(). */
#ifndef WP_TEST_H
#define WP_TEST_H

#include <stdio.h>
#include <stdlib.h>

static int wp_test_failures;

#define CHECK(cond) do { \
    if (!(cond)) { \
        fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
        wp_test_failures++; \
    } \
} while (0)

#define CHECK_EQ_U(a, b) do { \
    unsigned long long _a = (unsigned long long)(a), _b = (unsigned long long)(b); \
    if (_a != _b) { \
        fprintf(stderr, "%s:%d: %s == %s failed: %llu != %llu\n", \
                __FILE__, __LINE__, #a, #b, _a, _b); \
        wp_test_failures++; \
    } \
} while (0)

#define TEST_DONE() do { \
    if (wp_test_failures) { \
        fprintf(stderr, "%d failure(s)\n", wp_test_failures); \
        return 1; \
    } \
    printf("ok\n"); \
    return 0; \
} while (0)

#endif
