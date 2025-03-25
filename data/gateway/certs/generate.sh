#!/bin/bash

# Check if two parameters are provided
if [ $# -ne 2 ]; then
    echo "Usage: $0 <domain_name> <output_folder>"
    echo "Example: $0 lectorium.dev ./certs"
    exit 1
fi

# Assign parameters to variables
DOMAIN=$1
FOLDER=$2

# Create the output folder if it doesn't exist
mkdir -p "$FOLDER"

# Define file paths
KEY_FILE="$FOLDER/$FOLDER.key"
CSR_FILE="$FOLDER/$FOLDER.csr"
CRT_FILE="$FOLDER/$FOLDER.crt"
CONF_FILE="$FOLDER/$FOLDER.conf"

# Generate the OpenSSL configuration file
cat << EOF > "$CONF_FILE"
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
C = RS
ST = Beograd
L = Beograd
O = AKd Studios
CN = *.$DOMAIN

[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = *.$DOMAIN
DNS.2 = $DOMAIN
DNS.3 = minio.$DOMAIN
DNS.4 = airflow.$DOMAIN
EOF

# Generate the private key
openssl genpkey -algorithm RSA -out "$KEY_FILE" -pkeyopt rsa_keygen_bits:2048
if [ $? -ne 0 ]; then
    echo "Error: Failed to generate private key."
    exit 1
fi

# Generate the CSR
openssl req -new -key "$KEY_FILE" -out "$CSR_FILE" -config "$CONF_FILE"
if [ $? -ne 0 ]; then
    echo "Error: Failed to generate CSR."
    exit 1
fi

# Generate the self-signed certificate
openssl x509 -req -in "$CSR_FILE" -signkey "$KEY_FILE" -out "$CRT_FILE" -days 3650 -extfile "$CONF_FILE" -extensions req_ext
if [ $? -ne 0 ]; then
    echo "Error: Failed to generate certificate."
    exit 1
fi

echo "Success! Files generated in $FOLDER:"
ls -l "$FOLDER"