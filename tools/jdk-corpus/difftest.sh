#!/bin/bash
# Differential test: compile each program with javac 28 and with javac-js,
# run both on JDK 28 and compare the output.
J=${JDK28:-$HOME/git/jdk28-linux}
JDK=$J/build/jdk
R=$J/src/src/java.base/share/classes:$J/src/src/java.base/unix/classes:$J/src/src/java.base/linux/classes:$J/build/support/gensrc/java.base
HERE=$(cd "$(dirname "$0")/../.." && pwd)
WORK=${WORK:-/tmp/javac-js-difftest}
pass=0; fail=0
for f in "$@"; do
  n=$(basename "$f" .java)
  rm -rf "${WORK:?}/${n:?}"; mkdir -p "$WORK/$n/ref" "$WORK/$n/js"
  $JDK/bin/javac -d "$WORK/$n/ref" "$f" >/dev/null 2>"$WORK/$n/ref.err" || { echo "REFFAIL $n"; head "$WORK/$n/ref.err"; continue; }
  if ! node --stack-size=16000 "$HERE/scripts/javac-js.js" -v -d "$WORK/$n/js" -sourcepath "$R" "$f" 2>"$WORK/$n/js.err"; then
    echo "JSFAIL $n"; head -20 "$WORK/$n/js.err"; fail=$((fail+1)); continue
  fi
  $JDK/bin/java -cp "$WORK/$n/ref" "$n" > "$WORK/$n/ref.out" 2>&1
  $JDK/bin/java -Xverify:all -cp "$WORK/$n/js" "$n" > "$WORK/$n/js.out" 2>&1
  if cmp -s "$WORK/$n/ref.out" "$WORK/$n/js.out"; then echo "PASS $n"; pass=$((pass+1));
  else echo "DIFF $n"; diff "$WORK/$n/ref.out" "$WORK/$n/js.out" | head -30; fail=$((fail+1)); fi
done
echo "pass=$pass fail=$fail"
