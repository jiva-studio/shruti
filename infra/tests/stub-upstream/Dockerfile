# openssl mints the throwaway CA and the upstream certificates the test trusts.
FROM python:3.12-alpine
RUN apk add --no-cache openssl
COPY stub_upstream.py /app/stub_upstream.py
WORKDIR /app
CMD ["python", "-u", "stub_upstream.py"]
