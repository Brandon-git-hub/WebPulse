/* fx2lafw protocol constants and pure helpers (no libusb dependency). */
#ifndef WP_FX2_PROTO_H
#define WP_FX2_PROTO_H

#include <stddef.h>
#include <stdint.h>

#define FX2_VID_SALEAE      0x0925
#define FX2_PID_SALEAE      0x3881
#define FX2_VID_CYPRESS     0x04b4
#define FX2_PID_CYPRESS     0x8613

#define FX2_REQ_FIRMWARE    0xa0    /* EZ-USB RAM download (handled by silicon) */
#define FX2_CPUCS_ADDR      0xe600

#define FX2_CMD_GET_FW_VERSION      0xb0
#define FX2_CMD_START               0xb1
#define FX2_CMD_GET_REVID_VERSION   0xb2

#define FX2_START_FLAGS_SAMPLE_8BIT (0 << 5)
#define FX2_START_FLAGS_CLK_30MHZ   (0 << 6)
#define FX2_START_FLAGS_CLK_48MHZ   (1 << 6)

#define FX2_EP_DATA_IN      0x82
#define FX2_FW_MAJOR        1
#define FX2_MAX_SAMPLE_DELAY (6 * 256)
#define FX2_MAX_TRANSFERS   32
#define FX2_FW_CHUNK        4096

/* Build the 3-byte CMD_START payload {flags, delay_h, delay_l}.
 * Returns 0, or -1 if the rate cannot be generated. */
int wp_fx2_start_payload(uint64_t rate, uint8_t out[3]);

/* Bulk transfer sizing, following libsigrok's fx2lafw driver:
 * each transfer holds ~10 ms of data (multiple of 512 bytes) and the queue
 * holds ~500 ms in total, at most FX2_MAX_TRANSFERS transfers. */
size_t wp_fx2_transfer_size(uint64_t rate);
unsigned wp_fx2_num_transfers(uint64_t rate);
unsigned wp_fx2_timeout_ms(uint64_t rate);

#endif
