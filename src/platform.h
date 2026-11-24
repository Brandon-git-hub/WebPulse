/* Small portability layer: monotonic clock, sleep, random bytes. */
#ifndef WP_PLATFORM_H
#define WP_PLATFORM_H

#include <stddef.h>
#include <stdint.h>

uint64_t wp_now_ms(void);
uint64_t wp_now_us(void);
void wp_sleep_ms(unsigned ms);
/* Cryptographically secure random bytes. Returns 0 on success. */
int wp_random_bytes(void *buf, size_t n);
/* The operating system this runs on, e.g. "Windows 11 (build 26100)" or
 * "Linux 6.12.0 x86_64". */
void wp_os_name(char *buf, size_t n);

#endif
