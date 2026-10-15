#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
    printf 'Use Linux x64 ou o comando PowerShell para Windows.\n' >&2
    exit 1
fi
if (( EUID == 0 )); then
    printf 'Execute como usuario normal, sem sudo.\n' >&2
    exit 1
fi
command -v curl >/dev/null || { printf 'Instale curl e execute novamente.\n' >&2; exit 1; }
base="${XDG_DATA_HOME:-$HOME/.local/share}/fockytv/bootstrap"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
export PATH="$base/node/bin:$PATH"
if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)' 2>/dev/null; then
    printf 'Baixando Node.js LTS para compilar o plugin (sem alterar o Node do sistema)...\n'
    mkdir -p "$base"
    curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$stage/checksums"
    read -r checksum archive < <(awk '$2 ~ /^node-v[0-9.]+-linux-x64.tar.xz$/ {print $1, $2; exit}' "$stage/checksums")
    [[ $checksum =~ ^[a-fA-F0-9]{64}$ && $archive =~ ^node-v[0-9.]+-linux-x64.tar.xz$ ]] || { printf 'Manifesto Node invalido.\n' >&2; exit 1; }
    curl -fL --retry 3 "https://nodejs.org/dist/latest-v24.x/$archive" -o "$stage/$archive"
    printf '%s  %s\n' "$checksum" "$stage/$archive" | sha256sum -c -
    tar -xJf "$stage/$archive" -C "$stage"
    rm -rf "$base/node"
    mv "$stage/${archive%.tar.xz}" "$base/node"
fi
curl -fsSL --retry 3 https://raw.githubusercontent.com/FelipeMayerDev/fockytv-vencord-plugin/main/installer/install.mjs -o "$stage/install.mjs"
if ( : </dev/tty ) 2>/dev/null; then
    node "$stage/install.mjs" "$@" </dev/tty
else
    node "$stage/install.mjs" "$@"
fi
