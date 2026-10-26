#!/usr/bin/env python3
"""Create portable archives while preserving macOS framework symlinks/modes."""
import os
import pathlib
import re
import stat
import sys
import tarfile
import zipfile

source = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2]).resolve()
destination.parent.mkdir(parents=True, exist_ok=True)
temporary = re.compile(r'^\.(?:app\.asar|Electron Framework|Moye(?:\.exe)?)(?:\.[A-Za-z0-9_-]+)+$')
def product_entry(name):
    # Managed filesystem synchronization can expose transient staging trees
    # while directory entries are hydrated. They are never product resources.
    return all(part != '.rsync-tmp' and not temporary.fullmatch(part)
               for part in pathlib.PurePosixPath(name).parts)

if destination.name.endswith('.tar.gz'):
    with tarfile.open(destination, 'w:gz', compresslevel=6) as archive:
        archive.add(source, arcname=source.name, recursive=True,
                    filter=lambda info: info if product_entry(info.name) else None)
else:
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for directory, folders, files in os.walk(source, followlinks=False):
            folders[:] = sorted(name for name in folders if product_entry(name))
            for name in sorted(folders + files):
                if not product_entry(name):
                    continue
                item = pathlib.Path(directory) / name
                relative = item.relative_to(source.parent).as_posix()
                if item.is_symlink():
                    info = zipfile.ZipInfo(relative)
                    info.create_system = 3
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(info, os.readlink(item))
                else:
                    archive.write(item, relative)
print(destination)
