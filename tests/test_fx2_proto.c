#include "fx2_proto.h"
#include "device.h"
#include "test.h"

int main(void)
{
    uint8_t p[3];
    size_t i;

    CHECK(wp_fx2_start_payload(24000000, p) == 0);
    CHECK(p[0] == FX2_START_FLAGS_CLK_48MHZ && p[1] == 0 && p[2] == 1);
    CHECK(wp_fx2_start_payload(16000000, p) == 0 && p[2] == 2);
    CHECK(wp_fx2_start_payload(12000000, p) == 0 && p[2] == 3);
    CHECK(wp_fx2_start_payload(8000000, p) == 0 && p[2] == 5);
    CHECK(wp_fx2_start_payload(1000000, p) == 0 && p[0] == FX2_START_FLAGS_CLK_48MHZ && p[2] == 47);
    /* 20 kHz: 48 MHz delay too large -> 30 MHz clock, delay 1499 = 0x05db */
    CHECK(wp_fx2_start_payload(20000, p) == 0);
    CHECK(p[0] == FX2_START_FLAGS_CLK_30MHZ && p[1] == 0x05 && p[2] == 0xdb);
    /* 25 kHz: 48M/25k-1 = 1919 > 1536 -> 30M/25k-1 = 1199 */
    CHECK(wp_fx2_start_payload(25000, p) == 0 && p[0] == FX2_START_FLAGS_CLK_30MHZ);
    CHECK_EQ_U((p[1] << 8) | p[2], 1199);
    CHECK(wp_fx2_start_payload(48000000, p) < 0);
    CHECK(wp_fx2_start_payload(7000000, p) < 0);

    /* Every advertised rate must be encodable */
    for (i = 0; i < wp_fx2_nrates; i++)
        CHECK(wp_fx2_start_payload(wp_fx2_rates[i], p) == 0);

    /* libsigrok sizing at 24 MHz: 240128-byte transfers, 32 of them, 400 ms */
    CHECK_EQ_U(wp_fx2_transfer_size(24000000), 240128);
    CHECK_EQ_U(wp_fx2_num_transfers(24000000), 32);
    CHECK_EQ_U(wp_fx2_timeout_ms(24000000), 400);
    CHECK_EQ_U(wp_fx2_transfer_size(20000) % 512, 0);
    TEST_DONE();
}
