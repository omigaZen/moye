#!/usr/bin/env python3
"""Archive the complete source, local assets and review evidence, excluding profiles."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path)
parser.add_argument('--list-files', action='store_true', help='List selected source entries without creating an archive')
args = parser.parse_args()
version = json.loads((root / 'package.json').read_text())['version']
output = args.output or root / 'release' / f'Moye-{version}-source.zip'
entries = [
    'src', 'electron', 'assets', 'samples', 'scripts', 'tests', 'docs', 'native', '.github',
    'package.json', 'package-lock.json', 'README.md', 'AGENTS.md', '.gitignore',
    'LICENSE', 'THIRD-PARTY-NOTICES.md', 'SOURCE_VERSION.txt', 'RELEASE-MANIFEST.json',
]
excluded_directories = {'node_modules', '.git', '__pycache__', 'profile', 'profiles', 'userData', 'user-data', 'screenshots', 'release'}
executable_or_archive_extensions = {'.exe', '.dll', '.so', '.dylib', '.node', '.asar', '.dmg', '.msi', '.apk', '.deb', '.rpm', '.zip', '.7z', '.tar', '.gz', '.bz2', '.xz'}
def eligible(path):
    relative = path.relative_to(root)
    if path.is_symlink() or not path.is_file():
        return False
    if any(part in excluded_directories or part.startswith('screenshots-') for part in relative.parts[:-1]):
        return False
    if path.suffix.lower() in executable_or_archive_extensions or path.suffix in {'.pyc', '.cpuprofile', '.heapprofile'}:
        return False
    # Generated UI captures are review-only. Keep actual application/sample
    # images and deliberately checked-in test fixtures, including font assets.
    if relative.parts[0] in {'artifacts', 'tests'} and 'fixtures' not in relative.parts and path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm'}:
        return False
    return True
files = []
for entry in entries:
    path = root / entry
    if path.is_dir():
        files.extend(p for p in path.rglob('*') if eligible(p))
    elif eligible(path):
        files.append(path)
# Performance JSON and test logs contain generated fixture content only.
review_logs = {'unit-run.log', 'ui-final-run.log', 'unit-settings-run.log', 'ui-0.2.0-final.log', 'unit-0.3.0.log', 'ui-0.3.0-final.log',
               f'unit-{version}.log', f'ui-{version}-final.log', f'performance-{version}-final.log',
               f'package-{version}.log', f'packaged-features-{version}.log', f'package-audit-{version}.log',
               f'workspace-{version}-final.log', f'prepare-assets-{version}.log', f'memory-{version}.log'}
for path in (root / 'artifacts').glob('*'):
    if eligible(path) and (path.suffix == '.json' or path.name in review_logs):
        files.append(path)
files = sorted(set(files))
if args.list_files:
    print(json.dumps([str(path.relative_to(root)) for path in files], ensure_ascii=False))
    raise SystemExit(0)
output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='moye-source-archive-') as staging:
    staged = Path(staging) / output.name
    with zipfile.ZipFile(staged, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
        for path in files:
            archive.write(path, Path(f'Moye-{version}-source') / path.relative_to(root))
    with zipfile.ZipFile(staged) as archive:
        bad = archive.testzip()
        if bad is not None:
            raise ValueError(f'Source ZIP CRC failure: {bad}')
    with staged.open('rb') as stream:
        expected = hashlib.file_digest(stream, 'sha256').hexdigest()
    # Publish a complete, verified stream without overwriting old file extents.
    os.replace(staged, output)
    with output.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
            raise ValueError('Published source ZIP differs from verified staging ZIP')
print(json.dumps({'path': str(output.resolve()), 'files': len(files), 'bytes': output.stat().st_size}))
