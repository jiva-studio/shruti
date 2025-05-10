# ---------------------------------------------------------------------------- #
#                                     Base                                     #
# ---------------------------------------------------------------------------- #

FROM node:22.10.0-bookworm AS base

WORKDIR /akd-stidios/lectorium/
COPY package*.json ./ 
COPY apps/mobile/package*.json apps/mobile/
RUN npm install \
    && cd ./apps/mobile \
    && npm i
COPY . .

# ---------------------------------------------------------------------------- #
#                                     Build                                    #
# ---------------------------------------------------------------------------- #

FROM base AS build
RUN cd ./apps/mobile && npm run build

# ---------------------------------------------------------------------------- #
#                                    Release                                   #
# ---------------------------------------------------------------------------- #

FROM nginx:latest AS release

LABEL org.opencontainers.image.description="Mobile Web service for Lectorium"
LABEL org.opencontainers.image.source="https://github.com/akdasa-studios/lectorium"
LABEL org.opencontainers.image.authors="AKd Studios"

COPY --from=build /akd-stidios/lectorium/apps/mobile/dist /usr/share/nginx/html
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]