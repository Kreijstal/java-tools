#!/usr/bin/env bash
# cfr-check.sh — Check CFR decompiler output for structure markers
#
# Runs CFR on the given class/jar and reports how many bad-structure markers
# it emits. Used as a quality metric for deobfuscation passes.
#
# CFR markers that indicate problems:
#   ** GOTO              — unreducible goto (CFR gave up structuring)
#   Unable to fully...   — CFR could not fully structure the code
#   lbl-1000             — synthetic bad label (unresolved jump target)

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <file.{class,jar}> [cfr.jar path] [--full]"
    exit 1
fi

INPUT="$1"
CFR_JAR="${2:-}"
FULL="${3:-}"

JAVA_TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Find CFR jar
if [[ -z "$CFR_JAR" ]]; then
    CFR_JAR="$JAVA_TOOLS_DIR/lib/cfr.jar"
    if [[ ! -f "$CFR_JAR" ]]; then
        CFR_JAR=$(find "$JAVA_TOOLS_DIR" -name "cfr*.jar" 2>/dev/null | head -1)
    fi
    if [[ -z "$CFR_JAR" || ! -f "$CFR_JAR" ]]; then
        echo "[!] CFR jar not found. Download from https://www.benf.org/other/cfr/"
        echo "    Or: curl -sLo $JAVA_TOOLS_DIR/lib/cfr.jar https://www.benf.org/other/cfr/cfr-0.152.jar"
        exit 1
    fi
fi

TMPDIR=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "[*] Running CFR on $INPUT..."

java -jar "$CFR_JAR" "$INPUT" --outputdir "$TMPDIR" 2>/dev/null || true

echo "[*] Checking CFR output for structure markers..."

GOOD=0
WARN=0
BAD=0

while IFS= read -r -d '' file; do
    filename=$(basename "$file")
    markers=$(grep -c '\*\* GOTO\|Unable to fully structure code\|lbl-1000' "$file" 2>/dev/null || echo 0)

    if [[ $markers -gt 0 ]]; then
        BAD=$((BAD + 1))
        if [[ "$FULL" == "--full" ]]; then
            echo "  BAD: $filename ($markers marker(s))"
            grep -n '\*\* GOTO\|Unable to fully structure code\|lbl-1000' "$file" | head -5
        fi
        BAD_MARKERS=$((BAD_MARKERS + markers))
    else
        GOOD=$((GOOD + 1))
    fi
done < <(find "$TMPDIR" -name "*.java" -type f -print0 2>/dev/null)

echo ""
echo "=== CFR Quality Report ==="
echo "  Good (no markers): $GOOD classes"
echo "  Bad  (has markers): $BAD classes"
if [[ $BAD -gt 0 ]]; then
    echo "  Total bad markers:  $BAD_MARKERS"
fi

if [[ "$FULL" == "--full" && $BAD -gt 0 ]]; then
    echo ""
    echo "Bad files listed above."
fi

exit $BAD
