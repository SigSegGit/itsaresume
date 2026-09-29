# Word as a layout engine: one Word instance, driven over stdin/stdout.
#
# Each input line is a JSON request, each output line a JSON answer:
#   {"docx": "C:\\...\\cv.docx"}                      -> {"pages": 1, "fill": 0.83, ...}
#   {"docx": "C:\\...\\cv.docx", "pdf": "C:\\...\\cv.pdf"} -> the same, and a tagged PDF
#
# "fill" is how far down its last page the content ends (0..1), measured at
# the end of the document, which sits below the two-column table and so below
# the longer of the two columns. Word stays open between requests: starting it
# costs more than a measurement.

$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ($line.Trim() -eq '') { continue }
        try {
            $request = $line | ConvertFrom-Json
            $doc = $word.Documents.Open([string]$request.docx, $false, $true)
            try {
                $doc.ActiveWindow.View.Type = 3   # print layout: positions are page positions
                $doc.Repaginate()
                $end = $doc.Content
                $end.Collapse(0)                  # the very end of the document
                # The page the end of the document is on, not ComputeStatistics:
                # seen counting 1 page while the paragraph Word requires after
                # the table spilled onto a blank second one.
                $pages = [int]$end.Information(3)    # wdActiveEndPageNumber
                $y = [double]$end.Information(6)  # wdVerticalPositionRelativeToPage, points
                $height = [double]$doc.PageSetup.PageHeight
                $bottom = [double]$doc.PageSetup.BottomMargin
                $answer = [ordered]@{
                    pages = $pages
                    fill = [math]::Round($y / ($height - $bottom), 3)
                    endY = $y
                    pageHeight = $height
                    bottomMargin = $bottom
                }
                if ($request.pdf) {
                    # Tagged PDF (DocStructureTags) with document properties and
                    # bookmarks from headings: real text in reading order, which is
                    # what an ATS parser reads.
                    $doc.ExportAsFixedFormat([string]$request.pdf, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
                    $answer.pdf = [string]$request.pdf
                }
            } finally {
                $doc.Close(0)
            }
            [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress))
        } catch {
            [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
        }
        [Console]::Out.Flush()
    }
} finally {
    $word.Quit()
}
