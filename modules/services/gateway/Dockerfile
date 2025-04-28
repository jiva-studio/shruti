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
COPY ./services/gateway .

# ---------------------------------------------------------------------------- #
#                                      Run                                     #
# ---------------------------------------------------------------------------- #

ENTRYPOINT [ "/shruti/gateway/run.sh" ]