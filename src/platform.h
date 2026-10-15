/* Small portability layer: monotonic clock and sleep. */
#ifndef WP_PLATFORM_H
#define WP_PLATFORM_H

#include <stdint.h>

uint64_t wp_now_ms(void);
uint64_t wp_now_us(void);
void wp_sleep_ms(unsigned ms);

#endif
