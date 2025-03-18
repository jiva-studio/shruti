#!/bin/bash

# ---------------------------------------------------------------------------- #
#                              Installing Airflow                              #
# ---------------------------------------------------------------------------- #

sudo apt-get update && sudo apt-get install -y tzdata

cd ./modules/services/airflow/ 
python3 -m venv .venv
source .venv/bin/activate

pip install "apache-airflow[celery]==2.10.5" --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-2.10.5/constraints-3.12.txt"
pip install -r requirements.txt

# ---------------------------------------------------------------------------- #
#                                   Minio                                      #
# ---------------------------------------------------------------------------- #

wget https://dl.min.io/server/minio/release/linux-amd64/archive/minio_20250228095516.0.0_amd64.deb -O minio.deb
sudo dpkg -i minio.deb
rm ./minio.deb