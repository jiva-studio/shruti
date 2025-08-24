# ---------------------------------------------------------------------------- #
#                                     Base                                     #
# ---------------------------------------------------------------------------- #

FROM node:22.10.0-bookworm AS base

WORKDIR /akd-stidios/lectorium/
COPY apps/landing/package*.json apps/landing/
RUN cd ./apps/landing && npm i
COPY . .
RUN cd ./apps/landing && npm run build

# ---------------------------------------------------------------------------- #
#                                    Release                                   #
# ---------------------------------------------------------------------------- #

FROM nginx:latest AS release

LABEL org.opencontainers.image.description="Landing service for Lectorium"
LABEL org.opencontainers.image.source="https://github.com/akdasa-studios/lectorium"
LABEL org.opencontainers.image.authors="AKd Studios"

COPY --from=base /akd-stidios/lectorium/apps/landing/dist /usr/share/nginx/html
COPY --from=base /akd-stidios/lectorium/apps/landing/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]