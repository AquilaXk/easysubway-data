#!/usr/bin/env python3
import os
import sys


def main():
    if len(sys.argv) != 2:
        return 1
    name = sys.argv[1]
    if not name or name in {".", ".."} or "/" in name or "\x00" in name:
        return 1
    if os.open not in os.supports_dir_fd:
        return 1
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    try:
        fd = os.open(name, flags, 0o644, dir_fd=3)
        try:
            data = sys.stdin.buffer.read()
            offset = 0
            while offset < len(data):
                written = os.write(fd, data[offset:])
                if written <= 0:
                    return 1
                offset += written
        finally:
            os.close(fd)
    except BaseException:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
