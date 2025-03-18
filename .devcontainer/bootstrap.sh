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