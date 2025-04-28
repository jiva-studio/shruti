#!/bin/sh
nginx -c /shruti/gateway/nginx.$CONFIG_TYPE.conf -g 'daemon off;'