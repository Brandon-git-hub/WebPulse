#ifdef _WIN32
#define _CRT_RAND_S     /* rand_s() */
#endif
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>

int wp_random_bytes(void *buf, size_t n)
{
    uint8_t *p = buf;
    while (n) {
        unsigned int v;
        size_t k = n < sizeof(v) ? n : sizeof(v);
        if (rand_s(&v) != 0)
            return -1;
        memcpy(p, &v, k);
        p += k;
        n -= k;
    }
    return 0;
}

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

void wp_os_name(char *buf, size_t n)
{
    /* GetVersionEx reports 6.2 to programs without a compatibility manifest;
     * RtlGetVersion (always in ntdll, looked up at run time so no new import)
     * gives the real version. Windows 11 still says 10.0, from build 22000. */
    typedef LONG(WINAPI * rtl_get_version_fn)(OSVERSIONINFOW *);
    HMODULE ntdll = GetModuleHandleA("ntdll.dll");
    rtl_get_version_fn get = ntdll ? (rtl_get_version_fn)(void (*)(void))GetProcAddress(ntdll, "RtlGetVersion") : NULL;
    OSVERSIONINFOW v;
    memset(&v, 0, sizeof(v));
    v.dwOSVersionInfoSize = sizeof(v);
    if (!get || get(&v) != 0) {
        snprintf(buf, n, "Windows");
        return;
    }
    if (v.dwMajorVersion == 10 && v.dwBuildNumber >= 22000)
        snprintf(buf, n, "Windows 11 (build %lu)", (unsigned long)v.dwBuildNumber);
    else
        snprintf(buf, n, "Windows %lu.%lu (build %lu)", (unsigned long)v.dwMajorVersion,
                 (unsigned long)v.dwMinorVersion, (unsigned long)v.dwBuildNumber);
}
#else
#include <sys/utsname.h>
#include <time.h>

void wp_os_name(char *buf, size_t n)
{
    struct utsname u;
    if (uname(&u) != 0)
        snprintf(buf, n, "unknown");
    else
        snprintf(buf, n, "%s %s %s", u.sysname, u.release, u.machine);
}

int wp_random_bytes(void *buf, size_t n)
{
    FILE *f = fopen("/dev/urandom", "rb");
    size_t got = f ? fread(buf, 1, n, f) : 0;
    if (f)
        fclose(f);
    return got == n ? 0 : -1;
}

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
