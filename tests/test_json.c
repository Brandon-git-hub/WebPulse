#include "json.h"
#include "test.h"

#include <string.h>

int main(void)
{
    const char *js = "{ \"rate\": 24000000, \"pre\":0.25, \"nested\":{\"rate\":1},"
                     " \"trigger\" : \"XXXXXXXR\", \"esc\":\"a\\\"b\\\\c\", \"on\":true }";
    double d;
    char s[32], esc[64];

    CHECK(wp_json_num(js, strlen(js), "rate", &d) == 0 && d == 24000000);
    CHECK(wp_json_num(js, strlen(js), "pre", &d) == 0 && d == 0.25);
    CHECK(wp_json_num(js, strlen(js), "on", &d) == 0 && d == 1);
    CHECK(wp_json_num(js, strlen(js), "missing", &d) < 0);
    CHECK(wp_json_str(js, strlen(js), "trigger", s, sizeof(s)) == 0 && strcmp(s, "XXXXXXXR") == 0);
    CHECK(wp_json_str(js, strlen(js), "esc", s, sizeof(s)) == 0 && strcmp(s, "a\"b\\c") == 0);
    CHECK(wp_json_str(js, strlen(js), "rate", s, sizeof(s)) < 0);
    wp_json_escape("x\"y\n", esc, sizeof(esc));
    CHECK(strcmp(esc, "x\\\"y\\u000a") == 0);
    TEST_DONE();
}
