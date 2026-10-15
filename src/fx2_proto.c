#include "fx2_proto.h"

int wp_fx2_start_payload(uint64_t rate, uint8_t out[3])
{
    uint64_t delay = 0;
    uint8_t flags = 0;

    if (rate == 0)
        return -1;
    if (48000000ull % rate == 0) {
        flags = FX2_START_FLAGS_CLK_48MHZ;
        delay = 48000000ull / rate - 1;
        if (delay > FX2_MAX_SAMPLE_DELAY)
            delay = 0;
    }
    if (delay == 0 && 30000000ull % rate == 0) {
        flags = FX2_START_FLAGS_CLK_30MHZ;
        delay = 30000000ull / rate - 1;
    }
    if (delay == 0 || delay > FX2_MAX_SAMPLE_DELAY)
        return -1;

    out[0] = flags | FX2_START_FLAGS_SAMPLE_8BIT;
    out[1] = (uint8_t)((delay >> 8) & 0xff);
    out[2] = (uint8_t)(delay & 0xff);
    return 0;
}

static uint64_t bytes_per_ms(uint64_t rate)
{
    uint64_t b = rate / 1000;
    return b ? b : 1;
}

size_t wp_fx2_transfer_size(uint64_t rate)
{
    uint64_t s = 10 * bytes_per_ms(rate);
    return (size_t)((s + 511) & ~(uint64_t)511);
}

unsigned wp_fx2_num_transfers(uint64_t rate)
{
    uint64_t n = 500 * bytes_per_ms(rate) / wp_fx2_transfer_size(rate);
    if (n > FX2_MAX_TRANSFERS)
        n = FX2_MAX_TRANSFERS;
    if (n < 2)
        n = 2;
    return (unsigned)n;
}

unsigned wp_fx2_timeout_ms(uint64_t rate)
{
    uint64_t total = (uint64_t)wp_fx2_transfer_size(rate) * wp_fx2_num_transfers(rate);
    uint64_t t = total / bytes_per_ms(rate);
    t += t / 4;
    if (t < 100)
        t = 100;
    return (unsigned)t;
}
