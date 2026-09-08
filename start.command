#!/bin/bash
cd "$(dirname "$0")"
NODE="/Users/aymanalsahayan/Library/Application Support/Genspark Claw/bin/node"
echo "تشغيل منصة استبيانات أساب على http://localhost:4321 ..."
echo "لوحة الإدارة: http://localhost:4321/admin"
echo "(أغلق النافذة لإيقاف الخادم)"
PORT=4321 "$NODE" server.js
