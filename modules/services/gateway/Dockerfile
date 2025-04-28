FROM nginx:1.27.2-bookworm

# ---------------------------------------------------------------------------- #
#                                   Metadata                                   #
# ---------------------------------------------------------------------------- #

LABEL org.opencontainers.image.description="Gateway for the Shruti project"
LABEL org.opencontainers.image.source="https://github.com/akdasa-studios/shruti"

# ---------------------------------------------------------------------------- #
#                                     Build                                    #
# ---------------------------------------------------------------------------- #

WORKDIR /shruti/gateway
COPY . .

# ---------------------------------------------------------------------------- #
#                                      Run                                     #
# ---------------------------------------------------------------------------- #

CMD ["nginx", "-c", "/shruti/gateway/servers/shruti.dev.conf", "-g", "daemon off;"]
