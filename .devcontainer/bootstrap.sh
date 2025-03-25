#!/bin/bash

# ---------------------------------------------------------------------------- #
#                                   Minio                                      #
# ---------------------------------------------------------------------------- #

# ARCH=$(uname -m)
# if [ "$ARCH" == "x86_64" ]; then
#   MINIO_URL="https://dl.min.io/server/minio/release/linux-amd64/archive/minio_20250228095516.0.0_amd64.deb"
# elif [ "$ARCH" == "aarch64" ]; then
#   MINIO_URL="https://dl.min.io/server/minio/release/linux-arm64/archive/minio_20250228095516.0.0_arm64.deb"
# else
#   echo "Unsupported architecture: $ARCH"
#   exit 1
# fi

# wget $MINIO_URL -O minio.deb
# sudo dpkg -i minio.deb
# rm ./minio.deb

# ---------------------------------------------------------------------------- #
#                                    Gateway                                   #
# ---------------------------------------------------------------------------- #

mkdir -p /workspaces/lectorium/gateway/data/logs