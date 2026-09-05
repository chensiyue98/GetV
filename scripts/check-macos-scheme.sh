#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

scheme_output=$(xcodebuild -project get-v.xcodeproj -scheme 'get-v (macOS)' -showdestinations 2>&1)

if printf '%s\n' "$scheme_output" | grep -q 'Supported platforms for the buildables in the current scheme is empty'; then
    echo 'FAIL: macOS scheme reports an empty supported-platform set'
    exit 1
fi

if ! printf '%s\n' "$scheme_output" | grep -q 'platform:macOS'; then
    echo 'FAIL: macOS scheme has no macOS destination'
    exit 1
fi

echo 'PASS: macOS scheme has a compatible macOS destination'
