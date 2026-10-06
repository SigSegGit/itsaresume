#!/usr/bin/env bash
# scripts/check-workflow.py on two small workflows: a matrix job skipped at
# job level is refused; the same job with the condition on its steps passes.
set -u
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0
printf 'jobs:\n  test:\n    needs: changes\n    if: x\n    strategy:\n      matrix:\n        os: [a, b]\n    steps:\n      - run: t\n' > "$work/bad.yml"
printf 'jobs:\n  test:\n    needs: changes\n    strategy:\n      matrix:\n        os: [a, b]\n    steps:\n      - run: t\n        if: x\n  doc:\n    if: x\n    steps:\n      - run: d\n' > "$work/good.yml"
if python3 "$here/check-workflow.py" "$work/bad.yml" >/dev/null 2>&1 || python "$here/check-workflow.py" "$work/bad.yml" >/dev/null 2>&1; then
    echo "test a_matrix_job_skipped_at_job_level_is_refused ... FAILED"; failures=$((failures + 1))
else
    echo "test a_matrix_job_skipped_at_job_level_is_refused ... ok"
fi
py=python3; command -v python3 >/dev/null 2>&1 || py=python
if $py "$here/check-workflow.py" "$work/good.yml" >/dev/null 2>&1; then
    echo "test step_conditions_and_plain_job_skips_pass ... ok"
else
    echo "test step_conditions_and_plain_job_skips_pass ... FAILED"; failures=$((failures + 1))
fi
[ "$failures" -eq 0 ] && echo "check-workflow: 2 cases pass" || exit 1
