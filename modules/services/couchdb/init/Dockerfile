# ---------------------------------------------------------------------------- #
#                                     Build                                    #
# ---------------------------------------------------------------------------- #

FROM node:22-alpine3.19 AS builder
WORKDIR /akd-studios/lectorium/couchdb/init
COPY ./services/couchdb/init .
RUN npm install && npm run build

# ---------------------------------------------------------------------------- #
#                                    Release                                   #
# ---------------------------------------------------------------------------- #

FROM node:22-alpine3.19 AS release
LABEL org.opencontainers.image.description="CouchDB Boootstrap for the Lectorium project"
LABEL org.opencontainers.image.source="https://github.com/akdasa-studios/lectorium"

WORKDIR /akd-studios/lectorium/couchdb/init
COPY --from=builder /akd-studios/lectorium/couchdb/init .
CMD ["npm", "run", "migrate"]
