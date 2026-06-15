.PHONY: venv run test fmt clean

VENV := .venv
PY := $(VENV)/bin/python

venv:
	python3 -m venv $(VENV)
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -r requirements.txt

run:
	$(PY) -m denoiser_service

test:
	$(PY) -m pytest -q

clean:
	rm -rf $(VENV) __pycache__ denoiser_service/__pycache__
