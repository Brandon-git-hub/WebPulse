cmake_minimum_required(VERSION 3.20)
project(webpulse VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

find_package(Threads REQUIRED)

# --- libusb (optional: without it only the simulator backend is built) -----
option(WP_WITH_FX2 "Build the FX2 (libusb) backend if libusb-1.0 is found" ON)
set(WP_HAVE_FX2 OFF)
if(WP_WITH_FX2)
    find_package(PkgConfig QUIET)
    if(PKG_CONFIG_FOUND)
        pkg_check_modules(LIBUSB IMPORTED_TARGET libusb-1.0)
    endif()
    if(LIBUSB_FOUND)
        set(WP_HAVE_FX2 ON)
        message(STATUS "FX2 backend: enabled (libusb ${LIBUSB_VERSION})")
    else()
        message(STATUS "FX2 backend: disabled (libusb-1.0 not found)")
    endif()
endif()

set(WP_WARNINGS -Wall -Wextra -Wshadow -Wstrict-prototypes -Wno-unused-parameter)

# --- core library (no network, no USB) -------------------------------------
add_library(wpcore STATIC
    src/capture.c
    src/capture_store.c
    src/device.c
    src/dev_sim.c
    src/export.c
    src/fx2_proto.c
    src/json.c
    src/platform.c
    src/ringbuf.c
    src/trigger.c
    src/util.c
)
target_include_directories(wpcore PUBLIC src)
target_compile_options(wpcore PRIVATE ${WP_WARNINGS})
target_link_libraries(wpcore PUBLIC Threads::Threads)

if(WP_HAVE_FX2)
    target_sources(wpcore PRIVATE src/dev_fx2.c)
    target_compile_definitions(wpcore PUBLIC WP_HAVE_FX2=1)
    target_link_libraries(wpcore PUBLIC PkgConfig::LIBUSB)
endif()

# --- CivetWeb ---------------------------------------------------------------
add_library(civetweb STATIC third_party/civetweb/civetweb.c)
target_include_directories(civetweb PUBLIC third_party/civetweb)
target_compile_definitions(civetweb
    PUBLIC  USE_WEBSOCKET NO_SSL
    PRIVATE NO_CGI NO_CACHING)
target_compile_options(civetweb PRIVATE -w)
target_link_libraries(civetweb PUBLIC Threads::Threads)
if(WIN32)
    target_link_libraries(civetweb PUBLIC ws2_32)
else()
    target_link_libraries(civetweb PUBLIC ${CMAKE_DL_LIBS})
endif()

# --- embedded web assets ------------------------------------------------------
find_package(Python3 REQUIRED COMPONENTS Interpreter)
file(GLOB_RECURSE WP_WEB_FILES CONFIGURE_DEPENDS ${CMAKE_SOURCE_DIR}/web/*)
set(WP_WEB_ASSETS_C ${CMAKE_BINARY_DIR}/web_assets.c)
add_custom_command(
    OUTPUT ${WP_WEB_ASSETS_C}
    COMMAND Python3::Interpreter ${CMAKE_SOURCE_DIR}/tools/embed_web.py
            ${CMAKE_SOURCE_DIR}/web ${WP_WEB_ASSETS_C}
    DEPENDS ${WP_WEB_FILES} ${CMAKE_SOURCE_DIR}/tools/embed_web.py
    COMMENT "Embedding web/ into web_assets.c"
    VERBATIM)

# --- executable ---------------------------------------------------------------
add_executable(webpulse src/main.c src/server.c ${WP_WEB_ASSETS_C})
target_compile_options(webpulse PRIVATE ${WP_WARNINGS})
target_compile_definitions(webpulse PRIVATE WP_VERSION="${PROJECT_VERSION}")
target_link_libraries(webpulse PRIVATE wpcore civetweb)

# Ship the firmware next to the executable.
add_custom_command(TARGET webpulse POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory $<TARGET_FILE_DIR:webpulse>/firmware
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_SOURCE_DIR}/firmware/fx2lafw-saleae-logic.fw
            ${CMAKE_SOURCE_DIR}/firmware/COPYING
            ${CMAKE_SOURCE_DIR}/firmware/README.md
            $<TARGET_FILE_DIR:webpulse>/firmware/)

# --- tests (native builds only) -------------------------------------------------
if(NOT CMAKE_CROSSCOMPILING)
    enable_testing()
    foreach(t trigger store fx2_proto json capture export)
        add_executable(test_${t} tests/test_${t}.c)
        target_link_libraries(test_${t} PRIVATE wpcore)
        target_compile_options(test_${t} PRIVATE ${WP_WARNINGS})
        add_test(NAME ${t} COMMAND test_${t})
    endforeach()
endif()
