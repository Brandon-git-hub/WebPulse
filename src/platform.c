#include "platform.h"

#ifdef _WIN32
#include <windows.h>

uint64_t wp_now_us(void)
{
    static LARGE_INTEGER freq;
    LARGE_INTEGER now;
    if (freq.QuadPart == 0)
        QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&now);
    return (uint64_t)((unsigned __int128)now.QuadPart * 1000000u / (uint64_t)freq.QuadPart);
}

void wp_sleep_ms(unsigned ms)
{
    Sleep(ms);
}
#else
#include <time.h>

uint64_t wp_now_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000u + (uint64_t)ts.tv_nsec / 1000u;
}

void wp_sleep_ms(unsigned ms)
{
    struct timespec ts = { ms / 1000u, (long)(ms % 1000u) * 1000000L };
    nanosleep(&ts, NULL);
}
#endif

uint64_t wp_now_ms(void)
{
    return wp_now_us() / 1000u;
}
