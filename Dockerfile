# Use a lightweight Python base image suitable for production
FROM python:3.12-slim-bookworm

# Set the working directory in the container
WORKDIR /app

# Install build-time dependencies first (if any, though not strictly needed for this app yet)
# This helps with caching layers if requirements.txt changes less frequently than code
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of your application code into the container
# This includes main.py, stewAIrt/ (which contains agent.py and __init__.py),
# and the static/ directory (which contains your frontend JS/HTML files).
COPY . .

# --- IMPROVEMENT 1: Expose the port (good practice for clarity, though Cloud Run handles mapping) ---
# Explicitly expose the port your application will listen on.
# Uvicorn defaults to 8000, but Cloud Run provides a PORT environment variable.
EXPOSE 8080

# --- IMPROVEMENT 2: Dynamically set the port for Uvicorn using the Cloud Run PORT environment variable ---
# Cloud Run injects the 'PORT' environment variable into the container.
# Your application MUST listen on this specific port.
# We use 'sh -c' to allow shell variable expansion of $PORT.
CMD sh -c "uvicorn main:app --host 0.0.0.0 --port ${PORT}"