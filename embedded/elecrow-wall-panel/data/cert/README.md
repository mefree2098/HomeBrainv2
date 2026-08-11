# Embedded TLS trust bundle

`x509_crt_bundle.bin` is embedded in the panel firmware and used by
`WiFiClientSecure` to authenticate public HTTPS servers. Do not replace it with
an unverified download or disable certificate validation as a workaround.

The checked-in bundle was generated on 2026-08-11 from certifi 2026.02.25's
Mozilla CA store with Espressif IDF 5.1.6's `gen_crt_bundle.py`.

- Source PEM SHA-256: `ea7dd6b1af098dedb253a88c2ab29ded2752145f3c41b8e67abbad75c2d63cee`
- Bundle SHA-256: `a4bb07c275fd6c63ab7339e5b9b8beb8bab1aa70e71b27b7de05016a6ec985c2`

When refreshing the bundle, use the official Espressif generator, record the
certifi version and both hashes here, rebuild the firmware, and verify HTTPS
against the production endpoint before publishing it.
