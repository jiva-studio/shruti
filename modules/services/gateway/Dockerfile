FROM nginx:1.27.2-bookworm

# ---------------------------------------------------------------------------- #
#                                   Metadata                                   #
# ---------------------------------------------------------------------------- #

LABEL org.opencontainers.image.description="Gateway for the Lectorium project"
LABEL org.opencontainers.image.source="https://github.com/akdasa-studios/lectorium"

# ---------------------------------------------------------------------------- #
#                                     Build                                    #
# ---------------------------------------------------------------------------- #

WORKDIR /lectorium/gateway
COPY ./services/gateway .

# ---------------------------------------------------------------------------- #
#                                      Run                                     #
# ---------------------------------------------------------------------------- #

ENTRYPOINT [ "/lectorium/gateway/run.sh" ]