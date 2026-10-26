# Offline text encoding dependencies

- iconv-lite 0.6.3, MIT, https://github.com/ashtuchkin/iconv-lite
- safer-buffer 2.1.2, MIT, https://github.com/ChALkeR/safer-buffer

Copied from the runtime-owned npm distribution for offline packaging. Full runtime files, package metadata and licenses are retained. The only iconv-lite source adaptation replaces its safer-buffer package lookup with the relative bundled safer.js path. No node_modules directory is shipped or required. Per-file hashes are recorded in encoding-provenance.json.
