#!/bin/bash
# Make a merged source tree for module $1 (symlinks) under $2/<module>, with the
# JDK's precedence: gensrc > linux > unix > share. Includes module-info.java.
set -e
J=${JDK28:-$HOME/git/jdk28-linux}
mod=$1; dst=$2/$mod
G=$J/build/support/gensrc; S=$J/src/src
rm -rf "${dst:?}"; mkdir -p "$dst"
for root in $S/$mod/share/classes $S/$mod/unix/classes $S/$mod/linux/classes $G/$mod; do
  [ -d "$root" ] || continue
  (cd "$root" && find . -type f -name '*.java' ! -path '*snippet-files*') | while read f; do
    mkdir -p "$dst/$(dirname "$f")"
    ln -f "$root/$f" "$dst/$f"
  done
done
