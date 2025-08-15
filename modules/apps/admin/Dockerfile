# ---------------------------------------------------------------------------- #
#                                     Base                                     #
# ---------------------------------------------------------------------------- #

FROM node:22.10.0-bookworm AS base

WORKDIR /akd-stidios/shruti/
COPY apps/admin/package*.json apps/admin/
RUN cd apps/admin && npm i
COPY . .
RUN cd apps/admin && npm run build-only

# ---------------------------------------------------------------------------- #
#                                    Release                                   #
# ---------------------------------------------------------------------------- #

FROM nginx:latest AS release

LABEL org.opencontainers.image.description="Admin service for Shruti"
LABEL org.opencontainers.image.source="https://github.com/akdasa-studios/shruti"
LABEL org.opencontainers.image.authors="AKd Studios"

COPY --from=base /akd-stidios/shruti/apps/admin/dist /usr/share/nginx/html
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]