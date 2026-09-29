FROM python:3.12-slim

WORKDIR /app

COPY backend/snowflake-sso/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/snowflake-sso/app.py ./app.py

EXPOSE 8002

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8002"]
