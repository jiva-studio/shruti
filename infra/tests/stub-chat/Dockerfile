# Deliberately unpinned: the point of the e2e test is that the proxy keeps
# working against whatever Starlette the chat image is currently built on, so
# tracking upstream is the feature. If a future Starlette stops redirecting the
# bare mount path, this test still asserts the outcome that matters (a 200 with
# real samples on /chat/metrics), not the redirect itself.
FROM python:3.12-alpine
RUN pip install --no-cache-dir fastapi prometheus_client uvicorn
COPY stub_chat.py /app/stub_chat.py
WORKDIR /app
CMD ["uvicorn", "stub_chat:app", "--host", "0.0.0.0", "--port", "8080"]
