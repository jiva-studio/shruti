# ---------------------------------------------------------------------------- #
#                                     Base                                     #
# ---------------------------------------------------------------------------- #

FROM node:22.10.0-bookworm AS base

WORKDIR /akd-stidios/shruti/
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

LABEL org.opencontainers.image.description="Mobile Web service for Shruti"
LABEL org.opencontainers.image.source="https://github.com/jiva-studio/shruti"
LABEL org.opencontainers.image.authors="AKd Studios"

COPY --from=build /akd-stidios/shruti/apps/mobile/dist /usr/share/nginx/html
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]