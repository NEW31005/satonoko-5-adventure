#!/usr/bin/env sh
# Mock-HTTP test suite. Contacts nothing but 127.0.0.1.
# JEV_TIMEOUT_MS keeps the abort-path test from burning the real 10s timeout.
# Files are listed explicitly: the glob form of `node --test` does not exit here.
set -e
cd "$(dirname "$0")/../../.."
JEV_TIMEOUT_MS=800 exec node --test --test-timeout=30000 tools/jev/test/jev.test.mjs
