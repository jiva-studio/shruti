#!/bin/sh
nginx -c /lectorium/gateway/nginx.$CONFIG_TYPE.conf -g 'daemon off;'