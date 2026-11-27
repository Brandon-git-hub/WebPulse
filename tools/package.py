#!/usr/bin/env python3
"""Package a build into a release archive.

    tools/package.py [--unpacked] BUILD_DIR PLATFORM OUT_DIR

PLATFORM is e.g. win64 (-> .zip with webpulse.exe) or linux-x86_64 (-> .tar.gz).
The archive holds one top-level folder webpulse-<version>-<platform>/ with the
executable, wp-decode.mjs (see make_wp_decode), firmware/, decoders/
(example user decoders), the READMEs and LICENSE. The version is read from
CMakeLists.txt; the archive path is printed on stdout.

With --unpacked the same files are copied straight into OUT_DIR, without an
archive or the top-level folder: for a CI artifact, which GitHub zips itself
(an archive inside it would be a zip in a zip). Unpacked files lose the
executable bit, so this is meant for Windows.
"""
import json
import pathlib
import re
import shutil
import sys
import tarfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def version():
    m = re.search(r"project\(webpulse VERSION (\S+)", (ROOT / "CMakeLists.txt").read_text())
    if not m:
        sys.exit("package.py: no version in CMakeLists.txt")
    return m.group(1)


# Modules under web/ that tools/wp-decode.mjs uses: the decoder runtime and
# the built-in decoders.
BUNDLED = ["js/decode/runtime.js", "js/decode/export.js", "js/decode/assign.js"]
BUNDLE_LINE = "const BUNDLE = null;"


def make_wp_decode(path):
    """tools/wp-decode.mjs as one file that needs nothing from the repository:
    the modules and the version go into its BUNDLE constant."""
    web = ROOT / "web"
    names = BUNDLED + sorted(f"decoders/{f.name}" for f in (web / "decoders").glob("*.js"))
    bundle = {"version": version(), "modules": {n: (web / n).read_text(encoding="utf-8") for n in names}}
    src = (ROOT / "tools" / "wp-decode.mjs").read_text(encoding="utf-8")
    if src.count(BUNDLE_LINE) != 1:
        sys.exit(f"package.py: '{BUNDLE_LINE}' not found once in tools/wp-decode.mjs")
    # ensure_ascii: plain ASCII string literals, safe in any JS source.
    src = src.replace(BUNDLE_LINE, f"const BUNDLE = {json.dumps(bundle, ensure_ascii=True)};")
    path.write_text(src, encoding="utf-8", newline="\n")


def main():
    args = sys.argv[1:]
    unpacked = bool(args) and args[0] == "--unpacked"
    if unpacked:
        args = args[1:]
    if len(args) != 3:
        sys.exit(__doc__)
    build, platform, out = (pathlib.Path(args[0]), args[1], pathlib.Path(args[2]))
    windows = platform.startswith("win")
    exe = build / ("webpulse.exe" if windows else "webpulse")
    if not exe.is_file():
        sys.exit(f"package.py: {exe} not found")

    top = f"webpulse-{version()}-{platform}"
    wp_decode = build / "wp-decode.mjs"
    make_wp_decode(wp_decode)
    files = [(exe, exe.name), (wp_decode, wp_decode.name), (ROOT / "LICENSE", "LICENSE")]
    files += [(f, f.name) for f in sorted(ROOT.glob("README*.md"))]
    files += [(f, f"firmware/{f.name}") for f in sorted((ROOT / "firmware").iterdir()) if f.is_file()]
    files += [(f, f"decoders/{f.name}") for f in sorted((ROOT / "decoders").glob("*.js"))]

    out.mkdir(parents=True, exist_ok=True)
    if unpacked:
        for src, name in files:
            (out / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, out / name)
        print(out)
        return
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
                info.mode = 0o755 if src in (exe, wp_decode) else 0o644
                with open(src, "rb") as f:
                    t.addfile(info, f)
    print(path)


if __name__ == "__main__":
    main()
