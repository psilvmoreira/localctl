FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt debugpy
COPY . .
EXPOSE 8000 5678
# --reload: Tilt's live_update sync() only copies changed files into the container, it doesn't
# restart the process - uvicorn's --reload (via the `watchfiles` package) watches for that itself.
# WATCHFILES_FORCE_POLLING: Tilt's sync writes files via tar extraction, which doesn't reliably
# fire the inotify events watchfiles relies on by default - polling does (same fix as nodemon's
# -L/--legacy-watch in the Node example, different flag).
ENV WATCHFILES_FORCE_POLLING=true
CMD ["python", "-m", "debugpy", "--listen", "0.0.0.0:5678", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
