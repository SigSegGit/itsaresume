# -*- coding: utf-8 -*-
"""Turn Nicolas's two-column CV (the two-column design of 2026-07-02) into
a docxtemplater template, keeping its layout, fonts, colours and spacing.

    python tools/templatize.py <his-cv.docx> templates/two-column.docx [markers.json]

One exemplar paragraph of each kind is kept with its exact formatting and its
text replaced by a tag; repeated kinds become paragraph loops; every other
paragraph of his text is removed. The output holds tags only — the test
`the template holds tags only, no personal text` checks that — so it can be
committed while the source CV cannot.

This is a one-time tool written against that one file: it finds paragraphs by
the text they start with and refuses to run if any is missing.
"""

import html
import io
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile

# Paragraph kinds, found by the text they start with in the source CV. The
# markers are the owner's own text (his name, his email), so they live with
# his private data, not here: ~/.itsaresume/templatize-markers.json, or the
# file given as the third argument.
MARKERS = os.path.join(os.path.expanduser('~'), '.itsaresume', 'templatize-markers.json')


def load_markers(path):
    with io.open(path, encoding='utf-8') as handle:
        return json.load(handle)

# Paragraphs removed: the rest of each repeated run, by the text they start with
# (first of each) up to the next kept kind. Computed below from positions.


def text_of(p):
    return html.unescape(''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', p)))


def runs_of(p):
    return re.findall(r'<w:r[ >].*?</w:r>', p, re.S)


def rpr_of(run):
    m = re.search(r'<w:rPr>.*?</w:rPr>', run, re.S)
    return m.group(0) if m else ''


def with_runs(p, runs):
    """`p` with its runs replaced by `runs` (paragraph properties kept)."""
    start = re.search(r'<w:p[ >][^>]*>|<w:p>', p).group(0)
    ppr = re.search(r'<w:pPr>.*?</w:pPr>', p, re.S)
    return start + (ppr.group(0) if ppr else '') + ''.join(runs) + '</w:p>'


def run(rpr, text, tab=False):
    tabs = '<w:tab/>' if tab else ''
    return '<w:r>%s%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, tabs, html.escape(text, quote=False))


def tagged(p, tag):
    """`p` with one run holding `tag`, formatted like its first run."""
    runs = runs_of(p)
    return with_runs(p, [run(rpr_of(runs[0]) if runs else '', tag)])


def marker(p, tag):
    """A loop-marker paragraph; docxtemplater's paragraphLoop removes it."""
    return with_runs(p, [run('', tag)])


def main():
    source, target = sys.argv[1], sys.argv[2]
    FIND = load_markers(sys.argv[3] if len(sys.argv) > 3 else MARKERS)
    with zipfile.ZipFile(source) as z:
        xml = z.read('word/document.xml').decode('utf-8')

    matches = list(re.finditer(r'<w:p[ >].*?</w:p>', xml, re.S))
    texts = [text_of(m.group(0)) for m in matches]

    index = {}
    for kind, prefix in FIND.items():
        # First paragraph starting with the prefix, after the previous kind.
        after = max(index.values()) if index else -1
        found = next((i for i in range(after + 1, len(texts)) if texts[i].startswith(prefix)), None)
        if found is None:
            sys.exit('templatize: no paragraph starting with %r after #%d' % (prefix, after))
        index[kind] = found

    p = {kind: matches[i].group(0) for kind, i in index.items()}
    replacement = {}

    def put(kind, new):
        replacement[index[kind]] = new

    put('name', tagged(p['name'], '{name_caps}'))
    put('headline', tagged(p['headline'], '{headline}'))
    put('contact', tagged(p['contact'], '{contact}'))
    put('company', tagged(p['company'], '{company_line}'))

    for label in ('glance', 'skills', 'education', 'certifications', 'languages', 'profile', 'experience'):
        put(label + '_label', tagged(p[label + '_label'], '{labels.%s}' % label))

    put('glance_item', marker(p['glance_item'], '{#glance}') + tagged(p['glance_item'], '{.}') + marker(p['glance_item'], '{/glance}'))

    put('group_title', marker(p['group_title'], '{#skill_groups}') + tagged(p['group_title'], '{title}'))
    put('group_item', marker(p['group_item'], '{#items}') + tagged(p['group_item'], '{.}')
        + marker(p['group_item'], '{/items}') + marker(p['group_item'], '{/skill_groups}'))

    put('education_title', marker(p['education_title'], '{#education}') + tagged(p['education_title'], '{title}'))
    put('education_detail', marker(p['education_detail'], '{#details}') + tagged(p['education_detail'], '{.}')
        + marker(p['education_detail'], '{/details}') + marker(p['education_detail'], '{/education}'))

    put('certification', marker(p['certification'], '{#certifications}') + tagged(p['certification'], '{.}')
        + marker(p['certification'], '{/certifications}'))
    put('language', marker(p['language'], '{#languages}') + tagged(p['language'], '{.}')
        + marker(p['language'], '{/languages}'))

    put('profile_line', marker(p['profile_line'], '{#profile}') + tagged(p['profile_line'], '{.}')
        + marker(p['profile_line'], '{/profile}'))

    title_runs = runs_of(p['experience_title'])
    title = with_runs(p['experience_title'], [run(rpr_of(title_runs[0]), '{title}'),
                                               run(rpr_of(title_runs[-1]), '{dates}', tab=True)])
    put('experience_title', marker(p['experience_title'], '{#experiences}') + title)
    put('experience_org', tagged(p['experience_org'], '{org}'))
    put('experience_bullet', marker(p['experience_bullet'], '{#bullets}') + tagged(p['experience_bullet'], '{.}')
        + marker(p['experience_bullet'], '{/bullets}'))
    env_runs = runs_of(p['experience_env'])
    env = with_runs(p['experience_env'], [run(rpr_of(env_runs[0]), '{labels.env}'), run(rpr_of(env_runs[-1]), '{env}')])
    put('experience_env', marker(p['experience_env'], '{#has_env}') + env
        + marker(p['experience_env'], '{/has_env}') + marker(p['experience_env'], '{/experiences}'))

    # Every paragraph that holds text of his and is not a kept exemplar goes.
    kept = set(replacement)
    out, cursor = [], 0
    for i, m in enumerate(matches):
        out.append(xml[cursor:m.start()])
        if i in kept:
            out.append(replacement[i])
        elif texts[i].strip():
            pass  # his text: dropped
        else:
            out.append(m.group(0))  # spacers keep the vertical rhythm
        cursor = m.end()
    out.append(xml[cursor:])
    document = ''.join(out)

    # Word requires a paragraph after a table. At its default size it spilled
    # onto a blank second page when the table filled the first one exactly;
    # a 1 pt line with no spacing cannot.
    table_end = document.rindex('</w:tbl>') + len('</w:tbl>')
    trailing = re.match(r'<w:p\b[^>]*/>|<w:p\b.*?</w:p>', document[table_end:], re.S)
    if trailing:
        tiny = ('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>'
                '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>')
        document = document[:table_end] + tiny + document[table_end + trailing.end():]

    handle, temp = tempfile.mkstemp(suffix='.docx')
    import os
    os.close(handle)
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(temp, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == 'word/document.xml':
                data = document.encode('utf-8')
            elif item.filename == 'docProps/core.xml':
                data = re.sub(r'(<dc:creator>|<cp:lastModifiedBy>|<dc:title>)[^<]*', r'\1itsaresume-cv', data.decode('utf-8')).encode('utf-8')
            dst.writestr(item, data)
    shutil.move(temp, target)
    print('templatize: %d paragraphs kept as exemplars, template written to %s' % (len(kept), target))


if __name__ == '__main__':
    main()
