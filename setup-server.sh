#!/bin/bash
# BokaBord server setup — kör som root på dropleten
set -e

echo "=== Installerar Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "=== Installerar PM2 ==="
npm install -g pm2

echo "=== Installerar Nginx ==="
apt-get install -y nginx

echo "=== Installerar Playwright-beroenden ==="
apt-get install -y \
  libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libdbus-1-3 libxcb1 libxkbcommon0 libx11-6 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64

echo "=== Klonar BokaBord ==="
cd /var/www
git clone https://github.com/AntonioSaaranen/BokaBord boka-bord
cd boka-bord/server
npm install
npx playwright install chromium

echo "=== Konfigurerar Nginx ==="
cat > /etc/nginx/sites-available/boka-bord << 'EOF'
server {
    listen 80;
    server_name 104.248.21.95;

    # Statiska filer
    root /var/www/boka-bord;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # API-anrop vidarebefordras till Express
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/boka-bord /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== Startar servern med PM2 ==="
cd /var/www/boka-bord/server
pm2 start server.js --name boka-bord
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo ""
echo "=== Klart! ==="
echo "Öppna http://104.248.21.95 i webbläsaren"
