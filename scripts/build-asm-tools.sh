#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ASM_VERSION="${ASM_VERSION:-9.9.1}"
ASM_ROOT="${ASM_ROOT:-$HOME/.gradle/caches/modules-2/files-2.1/org.ow2.asm}"

find_jar() {
  local artifact="$1"
  find "$ASM_ROOT/$artifact/$ASM_VERSION" -type f -name "$artifact-$ASM_VERSION.jar" | head -1
}

ASM_JAR="$(find_jar asm)"
ASM_TREE_JAR="$(find_jar asm-tree)"
ASM_ANALYSIS_JAR="$(find_jar asm-analysis)"

if [[ -z "$ASM_JAR" || -z "$ASM_TREE_JAR" || -z "$ASM_ANALYSIS_JAR" ]]; then
  echo "Could not find ASM $ASM_VERSION jars under $ASM_ROOT" >&2
  exit 1
fi

mkdir -p build/asm-tools
javac -cp "$ASM_JAR:$ASM_TREE_JAR:$ASM_ANALYSIS_JAR" \
  -d build/asm-tools \
  tools/asm/JoinBlockSplitter.java

cat > build/asm-tools/run-join-block-splitter <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec java -cp "$(pwd)/build/asm-tools:$ASM_JAR:$ASM_TREE_JAR:$ASM_ANALYSIS_JAR" JoinBlockSplitter "\$@"
EOF
chmod +x build/asm-tools/run-join-block-splitter

echo "Built build/asm-tools/run-join-block-splitter"
