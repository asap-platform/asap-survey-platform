# منصة استبيانات أساب — Node 22 (node:sqlite مدمج) + zip (لتصدير Excel)
FROM node:22-bookworm-slim

# zip مطلوب لبناء ملفات XLSX
RUN apt-get update && apt-get install -y --no-install-recommends zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# مجلد البيانات الدائم (يُربط بـ Volume في Railway)
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 8080
ENV PORT=8080

# يزرع الاستبيان النموذجي مرة واحدة فقط إن لم توجد قاعدة بيانات، ثم يشغّل الخادم
CMD ["sh", "-c", "[ -f \"$DATA_DIR/surveys.db\" ] || node seed.js; node server.js"]
