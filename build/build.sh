#!/bin/sh
set -eu
if ! command -v pwsh >/dev/null 2>&1; then
    echo '[UBOVM] Install PowerShell 7 and put pwsh on PATH.' >&2
    exit 1
fi
if [ "$#" -gt 2 ]; then
    echo 'Usage: sh build/build.sh ACTION [folder or source action]' >&2
    exit 1
fi
UBOVM_ACTION=${1:-start}
UBOVM_ARGUMENT=${2:-}
UBOVM_SOURCE_DESKTOP=
UBOVM_SOURCE_WORKSPACE=
UBOVM_SOURCE_SMOKE=
export UBOVM_ACTION UBOVM_ARGUMENT UBOVM_SOURCE_DESKTOP UBOVM_SOURCE_WORKSPACE UBOVM_SOURCE_SMOKE
exec pwsh -NoLogo -NoProfile -File "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/build.ps1"
