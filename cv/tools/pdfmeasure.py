# -*- coding: utf-8 -*-
"""Print a PDF's length as the layout engine reports it, in JSON:
{"pages": N, "fill": f}, f the share of the last page's text area used.

    python tools/pdfmeasure.py cv.pdf

The text area runs from the first page's topmost text to the same distance
above the bottom edge (the template's margins are symmetric). Needs PyMuPDF.
"""
import json
import sys

import pymupdf

document = pymupdf.open(sys.argv[1])
pages = document.page_count
height = document[0].rect.height


def text_bottoms(page):
    return [block[3] for block in page.get_text('blocks') if block[4].strip()]


def text_tops(page):
    return [block[1] for block in page.get_text('blocks') if block[4].strip()]


tops = text_tops(document[0])
top = min(tops) if tops else 0.0
usable = max(height - 2 * top, 1.0)
bottoms = text_bottoms(document[pages - 1])
fill = (max(bottoms) - top) / usable if bottoms else 0.0
print(json.dumps({'pages': pages, 'fill': round(min(max(fill, 0.0), 1.0), 4)}))
