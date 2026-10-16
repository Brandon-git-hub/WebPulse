#!/usr/bin/env python3
"""Package a build into a release archive.

    tools/package.py BUILD_DIR PLATFORM OUT_DIR

PLATFORM is e.g. win64 (-> .zip with webpulse.exe) or linux-x86_64 (-> .tar.gz).
The archive holds one top-level folder webpulse-<version>-<platform>/ with the
executable, firmware/, README.md and LICENSE. The version is read from
CMakeLists.txt; the archive path is printed on stdout.
"""
import pathlib
import re
import sys
import tarfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def version():
    m = re.search(r"project\(webpulse VERSION (\S+)", (ROOT / "CMakeLists.txt").read_text())
    if not m:
        sys.exit("package.py: no version in CMakeLists.txt")
    return m.group(1)


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    build, platform, out = (pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3]))
    windows = platform.startswith("win")
    exe = build / ("webpulse.exe" if windows else "webpulse")
    if not exe.is_file():
        sys.exit(f"package.py: {exe} not found")

    top = f"webpulse-{version()}-{platform}"
    files = [(exe, exe.name), (ROOT / "README.md", "README.md"), (ROOT / "LICENSE", "LICENSE")]
    files += [(f, f"firmware/{f.name}") for f in sorted((ROOT / "firmware").iterdir()) if f.is_file()]

    out.mkdir(parents=True, exist_ok=True)
    if windows:
        path = out / f"{top}.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for src, name in files:
                z.write(src, f"{top}/{name}")
    else:
        path = out / f"{top}.tar.gz"
        with tarfile.open(path, "w:gz") as t:
            for src, name in files:
                info = t.gettarinfo(src, f"{top}/{name}")
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                info.mode = 0o755 if src == exe else 0o644
                with open(src, "rb") as f:
                    t.addfile(info, f)
    print(path)


if __name__ == "__main__":
    main()
