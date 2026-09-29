# -*- coding: utf-8 -*-
"""Print the text layer of a PDF in reading order, as an ATS would read it.

    python tools/pdftext.py cv.pdf

Needs PyMuPDF (`pip install pymupdf`).
"""
import sys

import pymupdf

document = pymupdf.open(sys.argv[1])
sys.stdout.reconfigure(encoding='utf-8')
# A form feed after each page, so a blank page shows up as one.
for page in document:
    sys.stdout.write(page.get_text('text') + '\f')
