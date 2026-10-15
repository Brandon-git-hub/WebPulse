#include "device.h"

const uint64_t wp_fx2_rates[] = {
    20000, 25000, 50000, 100000, 200000, 250000, 500000,
    1000000, 2000000, 3000000, 4000000, 6000000, 8000000,
    12000000, 16000000, 24000000,
};
const size_t wp_fx2_nrates = sizeof(wp_fx2_rates) / sizeof(wp_fx2_rates[0]);

int wp_device_rate_supported(wp_device *d, uint64_t rate)
{
    wp_device_info info;
    size_t i;

    d->ops->info(d, &info);
    for (i = 0; i < info.nrates; i++)
        if (info.rates[i] == rate)
            return 1;
    return 0;
}
