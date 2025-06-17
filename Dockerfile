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


# Command to run the application using Uvicorn in exec form.
# Use a sub-shell for the --port argument to allow variable expansion.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0"]
