FROM node:22

# ---------------------------------------------------------------------------- #
#                                     Meta                                     #
# ---------------------------------------------------------------------------- #

LABEL org.opencontainers.image.description="Lectorium Data Bundler"
LABEL org.opencontainers.image.source="https://github.com/akdasa-studios/lectorium"
LABEL org.opencontainers.image.authors="AKd Studios"

# ---------------------------------------------------------------------------- #
#                             Install Dependencies                             #
# ---------------------------------------------------------------------------- #

WORKDIR /tools
COPY package*.json ./
RUN npm install --python=python3

# ---------------------------------------------------------------------------- #
#                                  Copy Files                                  #
# ---------------------------------------------------------------------------- #

COPY ./tools/dataBundler .

# ---------------------------------------------------------------------------- #
#                                      Run                                     #
# ---------------------------------------------------------------------------- #

CMD ["node", "index.js"]
