# The CV generator on the Linux VM (ADR-11): Node, LibreOffice as the layout
# engine (Word's place), Carlito (metric-compatible with the template's
# Calibri), PyMuPDF for the PDF's length and its ATS read-back.
# The owner's profile is never in the image: it is mounted read-only at run
# time (/data/profile.json), the runs go to /data/out.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui fonts-crosextra-carlito fonts-liberation \
      python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages pymupdf \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV ITSACV_SOFFICE=soffice ITSACV_PYTHON=python3 HOME=/tmp
USER node
EXPOSE 8791
ENTRYPOINT ["node", "bin/itsacv.js"]
