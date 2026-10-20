#!/usr/bin/env bash
# 麦麦大亨 · 一键发布：建仓库 → 推代码 → 开 GitHub Pages
#
# 用法：
#   export GITHUB_TOKEN=ghp_xxxxxxxx        # 需要 repo 权限（classic 勾 repo，或 fine-grained 给 repo 的 Contents+Pages 读写）
#   bash tools/publish.sh
#
# 干跑（只看要做什么，不动线上）：
#   bash tools/publish.sh --dry-run
#
# 说明：Token 只在命令行里出现一次，不会被写进 .git/config，也不会进仓库。

set -euo pipefail

OWNER="${GITHUB_OWNER:-RockeyLD}"
REPO="${GITHUB_REPO:-mcd-mogul}"
BRANCH="${GITHUB_BRANCH:-main}"
API="https://api.github.com"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; }

# ── 0. 前置检查 ────────────────────────────────────────────────
say "前置检查"
if [ -n "$(git status --porcelain)" ]; then
  bad "工作区还有未提交的改动，先 git commit 再发"
  git status --short
  exit 1
fi
ok "工作区干净"

if [ "$DRY" = "0" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  bad "没设 GITHUB_TOKEN。先 export GITHUB_TOKEN=ghp_xxx，或加 --dry-run 只看流程"
  exit 1
fi

LOCAL_HEAD="$(git rev-parse --short HEAD)"
ok "本地 $BRANCH 在 $LOCAL_HEAD"

# ── 1. 建仓库（已存在就跳过）──────────────────────────────────
say "第 1 步 · 建仓库 $OWNER/$REPO"
EXISTS=0
if [ -z "${GITHUB_TOKEN:-}" ]; then
  ok "未设 Token，跳过探测（真实运行时这里会查一次仓库是否已存在）"
  _code="skip"
else
  _code=$(curl -s -o /tmp/mcd_repo.json -w '%{http_code}' -H "Authorization: Bearer $GITHUB_TOKEN" "$API/repos/$OWNER/$REPO")
fi
if [ "$_code" = "200" ]; then
  EXISTS=1
  ok "仓库已存在，跳过创建"
else
  ok "仓库不存在（HTTP ${_code}），准备创建"
fi

if [ "$EXISTS" = "0" ]; then
  if [ "$DRY" = "1" ]; then
    ok "[dry-run] 会 POST /user/repos 建一个 public 空仓库"
  else
    _code=$(curl -s -o /tmp/mcd_create.json -w '%{http_code}' -X POST \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "$API/user/repos" \
      -d "{\"name\":\"$REPO\",\"description\":\"用真实麦当劳 MCP 数据做的后厨做菜游戏 · 麦当劳程序员节创意开发大赛参赛作品\",\"homepage\":\"https://$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$REPO/\",\"private\":false,\"has_issues\":true,\"has_wiki\":false,\"auto_init\":false}")
    case "$_code" in
      201) ok "仓库已创建" ;;
      422) ok "同名仓库已存在（当作已创建）" ;;
      *)   bad "建仓库失败 HTTP $_code"; cat /tmp/mcd_create.json; exit 1 ;;
    esac
  fi
fi

# ── 2. 推送 ───────────────────────────────────────────────────
say "第 2 步 · 推送 $BRANCH"
if [ "$DRY" = "1" ]; then
  ok "[dry-run] 会 git push 到 https://x-access-token:***@github.com/$OWNER/$REPO.git"
else
  git -c credential.helper= push --quiet \
    "https://x-access-token:$GITHUB_TOKEN@github.com/$OWNER/$REPO.git" "$BRANCH:$BRANCH"
  ok "推送完成"
  git remote set-url origin "https://github.com/$OWNER/$REPO.git" 2>/dev/null || \
    git remote add origin "https://github.com/$OWNER/$REPO.git"
  git branch --quiet --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true
  ok "origin 已指回无 Token 的地址"
fi

# ── 3. 开 Pages ───────────────────────────────────────────────
say "第 3 步 · 开 GitHub Pages（main / 根目录）"
if [ "$DRY" = "1" ]; then
  ok "[dry-run] 会 POST /repos/$OWNER/$REPO/pages"
else
  _code=$(curl -s -o /tmp/mcd_pages.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "$API/repos/$OWNER/$REPO/pages" \
    -d "{\"source\":{\"branch\":\"$BRANCH\",\"path\":\"/\"}}")
  case "$_code" in
    201) ok "Pages 已开启" ;;
    409) ok "Pages 之前就开着" ;;
    *)   printf '  \033[33m!\033[0m Pages 开启返回 HTTP %s（不影响代码已上线，可在 Settings → Pages 手动开）\n' "$_code"
         head -c 300 /tmp/mcd_pages.json; echo ;;
  esac
fi

# ── 4. 收尾 ───────────────────────────────────────────────────
say "完成"
OWNER_LC="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
echo "  仓库   https://github.com/$OWNER/$REPO"
echo "  试玩   https://$OWNER_LC.github.io/$REPO/    （Pages 首次构建要 1~2 分钟）"
echo
echo "  接下来手动做两件事："
echo "    1) 仓库 About 右侧钩上 Use your GitHub Pages website"
echo "    2) 去大赛 Issue 发报名（正文见 SUBMIT.local.md）"
