# Included after project() via CMAKE_PROJECT_INCLUDE (set in mingw-w64-x86_64.cmake).
# The Windows-GNU platform module resets CMAKE_FIND_LIBRARY_SUFFIXES to prefer
# import libraries (.dll.a), which makes pkg_check_modules() resolve libusb to
# libusb-1.0.dll.a. Restrict lookups to static archives so the .exe is standalone.
set(CMAKE_FIND_LIBRARY_SUFFIXES ".a")
