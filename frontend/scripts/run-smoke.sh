#!/usr/bin/env bash
# 雨量代管权审核流冒烟脚本：tsc 编译 → 改写 @ 别名与扩展名 → node 执行。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=/tmp/smoke-rain
rm -rf "$OUT"

cat > /tmp/tsconfig.smoke.json <<EOF
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noImplicitAny": false,
    "skipLibCheck": true,
    "types": ["node"],
    "typeRoots": ["$PWD/node_modules/@types"],
    "outDir": "$OUT",
    "rootDir": "$PWD",
    "baseUrl": "$PWD",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["$PWD/scripts/smoke-rain-workflow.ts", "$PWD/src/data", "$PWD/src/api"]
}
EOF

./node_modules/.bin/tsc -p /tmp/tsconfig.smoke.json

python3 - "$OUT" <<'PYEOF'
import os, re, sys

root = sys.argv[1]
src_root = os.path.join(root, 'src')
for dirpath, _, files in os.walk(root):
    for name in files:
        if not name.endswith('.js'):
            continue
        path = os.path.join(dirpath, name)
        text = open(path, encoding='utf-8').read()

        def alias_to_relative(match):
            target = os.path.join(src_root, match.group(1)[2:] + '.js')
            rel = os.path.relpath(target, dirpath)
            return "from '%s'" % (rel if rel.startswith('.') else './' + rel)

        text = re.sub(r"from '(@/[^']+)'", alias_to_relative, text)
        text = re.sub(r"(from '\.{1,2}/[^']+?)(?<!\.js)'", r"\1.js'", text)
        open(path, 'w', encoding='utf-8').write(text)
PYEOF

node "$OUT/scripts/smoke-rain-workflow.js"
