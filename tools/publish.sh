#!/usr/bin/env bash
# 麦麦大亨 · 一键发布：建仓库 → 推代码 → 开 GitHub Pages
#
# 用法（三种给 Token 的方式，任选一种）：
#   1) 写文件（推荐，Token 不会出现在任何命令记录里，也不会进聊天）
#        echo 'ghp_xxxxxxxx' > tools/.github-token && chmod 600 tools/.github-token
#        bash tools/publish.sh
#   2) 环境变量
#        export GITHUB_TOKEN=ghp_xxxxxxxx && bash tools/publish.sh
#   3) 只想看它会做什么、不动线上
#        bash tools/publish.sh --dry-run
#
# Token 权限：classic 勾 repo；fine-grained 给 Contents 读写 + Pages 读写。
# 说明：Token 只在 curl/git 的命令行里出现一次，不会写进 .git/config，也不会进仓库
#      （tools/.github-token 已在 .gitignore 里）。

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

# macOS 自带的不是 GNU coreutils，没有 timeout；perl 一定有
sh_timeout() {
  local secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  else perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
  fi
}

# ── 0. 前置检查 ────────────────────────────────────────────────
say "前置检查"
if [ -n "$(git status --porcelain)" ]; then
  bad "工作区还有未提交的改动，先 git commit 再发"
  git status --short
  exit 1
fi
ok "工作区干净"

# Token：环境变量优先，其次读 tools/.github-token
TOKEN_FILE="tools/.github-token"
if [ -z "${GITHUB_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
  GITHUB_TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
  ok "已从 $TOKEN_FILE 读到 Token"
fi

if [ "$DRY" = "0" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  bad "没有 Token。二选一："
  echo "      echo 'ghp_xxx' > $TOKEN_FILE && chmod 600 $TOKEN_FILE"
  echo "      export GITHUB_TOKEN=ghp_xxx"
  echo "   只想看流程就加 --dry-run"
  exit 1
fi

LOCAL_HEAD="$(git rev-parse --short HEAD)"
ok "本地 $BRANCH 在 $LOCAL_HEAD"

# ── 1. 建仓库（已存在就跳过）──────────────────────────────────
say "第 1 步 · 建仓库 $OWNER/$REPO"
EXISTS=0
if [ -z "${GITHUB_TOKEN:-}" ]; then
  ok "未设 Token，跳过探测（真实运行时会先查一次仓库在不在）"
  _code="skip"
else
  _code=$(curl -s -o /tmp/mcd_repo.json -w '%{http_code}' -H "Authorization: Bearer $GITHUB_TOKEN" "$API/repos/$OWNER/$REPO")
  if [ "$_code" = "200" ]; then
    EXISTS=1
    ok "仓库已存在，跳过创建"
  else
    ok "仓库不存在（HTTP ${_code}），准备创建"
  fi
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
  ok "[dry-run] push 连不上时自动改走 tools/push-via-api.js（REST API 重建历史）"
else
  # 先走正常 git 协议；github.com:443 被墙/被掐时（沙箱里就是 502）改走 REST API。
  # 两条路的 commit sha 完全一致，不存在分叉，随时可以换回来。
  : > /tmp/mcd_push_err                                   # 别读到上一轮留下的旧报错
  # set -e 下 `A=$(curl ...)` 会因为 curl 超时退出码 28 把整个脚本带走，
  # 所以必须写成 `A=$(...) || A=000` —— 这样整条语句的退出码是 0。
  # curl 连不上时 -w 本身已输出 000，别再追加一次，否则会看到 HTTP 000000。
  _gh=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://github.com 2>/dev/null) || _gh=000
  _gh=${_gh:-000}
  _gh=$(printf '%s' "$_gh" | tail -c 3)                   # 防御：只留最后三位
  if [ "$_gh" != "200" ]; then
    printf '  \033[33m!\033[0m github.com 不通（HTTP %s）→ 直接用 REST API\n' "$_gh"
    _push_ok=1
  elif sh_timeout 90 git -c credential.helper= push --quiet \
       "https://x-access-token:$GITHUB_TOKEN@github.com/$OWNER/$REPO.git" "$BRANCH:$BRANCH" 2>/tmp/mcd_push_err; then
    ok "推送完成（git 协议）"
    _push_ok=0
  else
    _push_ok=1
  fi
  if [ "$_push_ok" = "1" ]; then
    if [ -s /tmp/mcd_push_err ]; then
      printf '  \033[33m!\033[0m git 协议失败（%s）→ 改走 REST API\n' "$(tr -d '\r' < /tmp/mcd_push_err | tail -2 | tr '\n' ' ')"
    fi
    GITHUB_TOKEN="$GITHUB_TOKEN" GITHUB_OWNER="$OWNER" GITHUB_REPO="$REPO" GITHUB_BRANCH="$BRANCH" \
      node tools/push-via-api.js || { bad "API 推送也失败"; exit 1; }
  fi
  git remote set-url origin "https://github.com/$OWNER/$REPO.git" 2>/dev/null || \
    git remote add origin "https://github.com/$OWNER/$REPO.git"
  # git 协议不通就 fetch 不了，跟踪分支得手动对齐；API 推送的 sha 与本地一致，直接指过去
  git update-ref "refs/remotes/origin/$BRANCH" "$(git rev-parse HEAD)"
  git branch --quiet --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true
  ok "origin 已指回无 Token 的地址，跟踪分支对齐到 $(git rev-parse --short HEAD)"
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
