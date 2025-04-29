# ---------------------------------------------------------------------------- #
#                                     Base                                     #
# ---------------------------------------------------------------------------- #

FROM node:22.10.0-bookworm AS base

WORKDIR /akd-stidios/lectorium/
COPY package*.json ./ 
COPY services/api/package*.json services/api/
RUN npm i \
    && cd ./services/api \
    && npm i
COPY services/api services/api
COPY libs/protocol libs/protocol

# ---------------------------------------------------------------------------- #
#                                     Build                                    #
# ---------------------------------------------------------------------------- #

FROM base AS build
RUN cd ./services/api && npm run build

# ---------------------------------------------------------------------------- #
#                                    Release                                   #
# ---------------------------------------------------------------------------- #

FROM node:22.10.0-bookworm AS release

LABEL org.opencontainers.image.description="Api service for Lectorium"
LABEL org.opencontainers.image.source="https://github.com/akdasa-studios/lectorium"
LABEL org.opencontainers.image.authors="AKd Studios"

WORKDIR /akd-stidios/lectorium/
COPY services/api/package*.json .
COPY --from=build /akd-stidios/lectorium/services/api/dist .
RUN npm i

# Copy assets
COPY services/api/src/auth/templates src/auth/templates

EXPOSE 8101

CMD ["node", "./services/api/src/main"]
