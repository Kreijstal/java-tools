#!/bin/bash
# Compile java.base and the javac modules with javac-js, put the classes into a
# copy of the exploded JDK 28 image (module-info.class files stay javac's).
set -e
J=${JDK28:-$HOME/git/jdk28-linux}
HERE=$(cd "$(dirname "$0")/../.." && pwd)
WORK=${WORK:?set WORK}
MODULES=${MODULES:-java.base java.compiler jdk.internal.opt jdk.compiler}
G=$J/build/support/gensrc
S=$J/src/src
R=$G/java.base:$S/java.base/linux/classes:$S/java.base/unix/classes:$S/java.base/share/classes:$S/java.compiler/share/classes:$G/jdk.compiler:$S/jdk.compiler/share/classes:$S/jdk.internal.opt/share/classes
T=$WORK/jdk-js
rm -rf "${T:?}"; cp -rlL $J/build/jdk "$T"
for mod in $MODULES; do
  node $HERE/tools/jdk-corpus/module-sources.js $G/$mod $S/$mod/linux/classes $S/$mod/unix/classes $S/$mod/share/classes > $WORK/$mod-files.txt
  OUT=$WORK/out-$mod
  rm -rf "${OUT:?}"; mkdir -p "$OUT"
  echo "== $mod: $(wc -l < $WORK/$mod-files.txt) files"
  (cd $J && node --max-old-space-size=12000 --stack-size=16000 $HERE/scripts/javac-js.js -d "$OUT" -sourcepath "$R" $(cat $WORK/$mod-files.txt)) 2>&1 | tail -5
  (cd "$OUT" && find . -name '*.class' -exec cp --remove-destination {} "$T/modules/$mod/{}" \;)
done
echo "image ready: $T"
