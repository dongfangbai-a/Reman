#!/usr/bin/env bash
# 判分容器没起来（Windows 资源耗尽、disk、compose 报错）时，用还在跑/还活着的 agent 容器补判分。
#
#   ./eval/terminal-bench/rescore.sh eval/evidence/terminal-bench/cc-1111-1854/shadow-relay__RbcZkbV
#
# 做的事和 Harbor 正常判分完全一样：在 agent 容器里按 task.toml 的 collect 命令生成 patch，
# 构建题目自带的 tests/Dockerfile，把 patch 应用到干净镜像上跑 test.sh，最后打印 reward。
set -euo pipefail
cd "$(dirname "$0")/../.."

TRIAL=${1:?用法：./eval/terminal-bench/rescore.sh <试次目录>}
[ -d "$TRIAL" ] || { echo "没有这个目录：$TRIAL"; exit 1; }

# 试次名形如 <题目>__<随机>，容器名是 <题目>__<小写随机>__env-main-1
TASK=$(basename "$TRIAL" | cut -d_ -f1)
CONTAINER=$(docker ps --format '{{.Names}}' | grep -i "^${TASK}__.*__env-main-1$" | head -1)
[ -n "$CONTAINER" ] || { echo "找不到 ${TASK} 的容器；如果已经被删了，就只能靠拷贝出来的产物（见 README）。"; exit 1; }

WORK="$TRIAL/artifacts/manual"
mkdir -p "$WORK/verify"

echo "==> 在 $CONTAINER 里生成 patch"
docker cp eval/.cache/tools/collect-patch.sh "$CONTAINER:/tmp/collect-patch.sh" >/dev/null
docker exec "$CONTAINER" bash /tmp/collect-patch.sh >/dev/null
docker cp "$CONTAINER:/tmp/agent.patch" "$WORK/agent.patch" >/dev/null

echo "==> 构建 ${TASK} 的判分镜像"
TAG="verifier-$(echo "$TASK" | tr '[:upper:]' '[:lower:]')"
PROXY_ARGS=()
if curl -s -m 2 -o /dev/null http://127.0.0.1:7898 2>/dev/null || (exec 3<>/dev/tcp/127.0.0.1/7898) 2>/dev/null; then
	PROXY_ARGS=(--build-arg "HTTP_PROXY=http://host.docker.internal:7898" --build-arg "HTTPS_PROXY=http://host.docker.internal:7898")
fi
docker build -q -t "$TAG" "${PROXY_ARGS[@]}" "eval/.cache/datasets/terminal-bench/$TASK/tests"

echo "==> 跑判分"
docker run --rm \
	-v "$(cd "$WORK" && pwd -W 2>/dev/null || cd "$WORK" && pwd):/in:ro" \
	-v "$(cd "$WORK/verify" && pwd -W 2>/dev/null || cd "$WORK/verify" && pwd):/logs" \
	"$TAG" bash -c 'cp /in/agent.patch /tmp/agent.patch && bash /tests/test.sh'

echo
echo "reward = $(cat "$WORK/verify/verifier/reward.txt" 2>/dev/null || cat "$WORK/verify/reward.txt" 2>/dev/null || echo '没写出来')"
