# Cross-compile toolchain: Linux host -> Windows x86_64 (llvm-mingw, UCRT)
#
# Usage:
#   cmake -S . -B build/win -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-w64-x86_64.cmake
#
# Tools are installed under ${TOOLS_ROOT} (default /mnt/ssd/tools), not via apt,
# and are not guaranteed to be on PATH, so every path here is absolute.

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

if(DEFINED ENV{TOOLS_ROOT})
    set(TOOLS_ROOT "$ENV{TOOLS_ROOT}")
else()
    set(TOOLS_ROOT "/mnt/ssd/tools")
endif()

set(MINGW_ROOT    "${TOOLS_ROOT}/mingw-w64/current")
set(MINGW_TRIPLE  "x86_64-w64-mingw32")
set(MINGW_SYSROOT "${MINGW_ROOT}/${MINGW_TRIPLE}")
set(PKGCONF_ROOT  "${TOOLS_ROOT}/pkgconf")

# --- Compilers / binutils ---------------------------------------------------
set(CMAKE_C_COMPILER   "${MINGW_ROOT}/bin/${MINGW_TRIPLE}-gcc")
set(CMAKE_CXX_COMPILER "${MINGW_ROOT}/bin/${MINGW_TRIPLE}-g++")
set(CMAKE_RC_COMPILER  "${MINGW_ROOT}/bin/${MINGW_TRIPLE}-windres")
set(CMAKE_AR           "${MINGW_ROOT}/bin/${MINGW_TRIPLE}-ar" CACHE FILEPATH "")
set(CMAKE_RANLIB       "${MINGW_ROOT}/bin/${MINGW_TRIPLE}-ranlib" CACHE FILEPATH "")

# --- find_* search: only the Windows sysroot, never host libraries ----------
set(CMAKE_FIND_ROOT_PATH "${MINGW_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)   # host tools (python, etc.)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# --- pkg-config: Windows-only search path -----------------------------------
# These ENV settings apply only to this CMake process and its children
# (FindPkgConfig runs pkgconf at configure time), so the user's shell and
# native Linux builds keep their normal pkg-config behaviour.
set(PKG_CONFIG_EXECUTABLE "${PKGCONF_ROOT}/bin/${MINGW_TRIPLE}-pkg-config" CACHE FILEPATH "")
set(ENV{PKG_CONFIG_LIBDIR} "${MINGW_SYSROOT}/lib/pkgconfig")
set(ENV{PKG_CONFIG_PATH} "")
# pkgconf needs its own libpkgconf.so.8, which may not be on LD_LIBRARY_PATH
# when CMake is started from a non-interactive shell or a code-server task.
set(ENV{LD_LIBRARY_PATH} "${PKGCONF_ROOT}/lib:$ENV{LD_LIBRARY_PATH}")

# --- Link statically: single .exe, no libusb-1.0.dll / libwinpthread-1.dll --
# -static covers -l<name> lookups (winpthread, etc.); full library paths found
# by pkg_check_modules() are made static by mingw-w64-static-libs.cmake.
set(CMAKE_EXE_LINKER_FLAGS_INIT "-static")
set(CMAKE_PROJECT_INCLUDE "${CMAKE_CURRENT_LIST_DIR}/mingw-w64-static-libs.cmake")
