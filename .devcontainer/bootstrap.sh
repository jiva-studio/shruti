#!/bin/bash

# ---------------------------------------------------------------------------- #
#                                    Gateway                                   #
# ---------------------------------------------------------------------------- #

mkdir -p /workspaces/shruti/gateway/data/logs

# ---------------------------------------------------------------------------- #
#                                   CocoaPods                                  #
# ---------------------------------------------------------------------------- #

sudo apt update
sudo apt install -y ruby-full build-essential ffmpeg ripgrep fd-find
sudo gem install cocoapods bundler

# ---------------------------------------------------------------------------- #
#                                     NVim                                     #
# ---------------------------------------------------------------------------- #

ARCH=$(uname -m)
if [ "$ARCH" == "x86_64" ]; then
  curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz
  sudo rm -rf /opt/nvim
  sudo tar -C /opt -xzf nvim-linux64.tar.gz
  export PATH="$PATH:/opt/nvim-linux64/bin"
elif [ "$ARCH" == "aarch64" ]; then
  curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux-arm64.tar.gz
  sudo rm -rf /opt/nvim
  sudo tar -C /opt -xzf nvim-linux-arm64.tar.gz
  export PATH="$PATH:/opt/nvim-linux-arm64/bin"
else
  echo "Unsupported architecture: $ARCH"
fi

# ---------------------------------------------------------------------------- #
#                                    NvChad                                    #
# ---------------------------------------------------------------------------- #

mkdir -p "$HOME/.config"
ln -s "/workspaces/shruti/.devcontainer/nvim" "$HOME/.config/"

