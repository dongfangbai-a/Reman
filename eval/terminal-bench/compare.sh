#!/usr/bin/env bash
# 比 reman / Claude Code / DeepSeek Harness：同一道题、同一个模型、同样的窗口设置，各跑一次。
#
#   ./eval/compare.sh -a reman -i embedding-drift-monitor
#   ./eval/compare.sh -a cc    -i risk-scorer-replay -t 10800
#   ./eval/compare.sh -a dsh   -i mp-checkpoint-consolidation
#
# 单个进程只跑一个 agent、一道题、一个并发（-n 1）。要比三家，就并行起三个进程（见 EXTRA.md）。
# 口径：输出上限和思考强度三家统一（65536、high），窗口按各家压缩策略倒推（见下面 WINDOW 那几行）。
set -euo pipefail
# 脚本在 eval/terminal-bench/，工作目录回到仓库根。
cd "$(dirname "$0")/../.."

HARBOR=./eval/.cache/tools/bin/harbor.exe
DATASET=eval/.cache/datasets/terminal-bench
AGENT=""
TASKS=()
# 单场上限。任务本身给的 agent 超时是 8 小时，这里收紧成 3 小时。
TIMEOUT_SEC=${REMAN_EVAL_TIMEOUT_SEC:-10800}
TASK_AGENT_TIMEOUT_SEC=28800
EFFORT=${EFFORT:-high}
# 口径：三家的窗口各不一样，但「压缩触发点」都落在 35 万 token 附近——比长程能力时这才是同一个起点。
#   reman 在窗口的 0.7 处压缩          → 500,000 × 0.7 = 350,000
#   dsh  在「窗口 − 输出预留 − 64k」处压缩 → 480,000 − 65,536 − 65,536 = 348,928
#   cc   用 AUTOCOMPACT_PCT_OVERRIDE 指定 → 440,000 × 80% = 352,000
# 给了 -c/--context 时三家都用这个值（老口径，只留作对照）。
CONTEXT_WINDOW=${CONTEXT_WINDOW:-}
REMAN_WINDOW=${REMAN_WINDOW:-500000}
DSH_WINDOW=${DSH_WINDOW:-480000}
CC_WINDOW=${CC_WINDOW:-440000}
CC_COMPACT_PCT=${CC_COMPACT_PCT:-80}
# 一次回复最多多少 token：模型单次能想 384K，不限制的话一份输出就能把窗口撑爆。
# 输出上限：给它赋空值（MAX_OUTPUT_TOKENS=）就是「不额外设置」，跟第一批那 9 场一样；
# 给了值才往容器里传 MAX_OUTPUT_TOKENS / *_EVAL_MAX_TOKENS。
MAX_OUTPUT_TOKENS=${MAX_OUTPUT_TOKENS-65536}
STAMP=$(date +%m%d-%H%M)
# 容器访问宿主机代理用的地址（Clash 只监听 127.0.0.1，靠 proxy-relay 转出来）。
CONTAINER_PROXY=${CONTAINER_PROXY:-http://host.docker.internal:7898}
EXTRA=()

while [ $# -gt 0 ]; do
	case "$1" in
		-a|--agent) AGENT="$2"; shift 2 ;;
		-i|--include) TASKS+=(-i "$2"); shift 2 ;;
		-t|--timeout) TIMEOUT_SEC="$2"; shift 2 ;;
		-e|--effort) EFFORT="$2"; shift 2 ;;
		-c|--context) CONTEXT_WINDOW="$2"; shift 2 ;;
		*) EXTRA+=("$1"); shift ;;
	esac
done

if [ -z "$AGENT" ]; then echo "要指定 -a reman|cc|dsh"; exit 1; fi
# 老口径：-c 指定了就用同一个窗口。
if [ -n "$CONTEXT_WINDOW" ]; then
	REMAN_WINDOW=$CONTEXT_WINDOW; DSH_WINDOW=$CONTEXT_WINDOW; CC_WINDOW=$CONTEXT_WINDOW
fi
if [ ${#TASKS[@]} -eq 0 ]; then echo "要指定题目：-i <glob>（可重复）"; exit 1; fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
	KEY_DIR="$LOCALAPPDATA/Reman"
	DEEPSEEK_API_KEY=$(node eval/decrypt-key.mjs "$KEY_DIR" deepseek)
	export DEEPSEEK_API_KEY
fi

# 适配器在 eval/terminal-bench/ 下。
export PYTHONPATH=eval/terminal-bench
export REMAN_EVAL_TIMEOUT_SEC="$TIMEOUT_SEC"
export REMAN_EVAL_REASONING="$EFFORT"
export REMAN_EVAL_CONTEXT_WINDOW="$REMAN_WINDOW"
if [ -n "$MAX_OUTPUT_TOKENS" ]; then
	export REMAN_EVAL_MAX_OUTPUT_TOKENS="$MAX_OUTPUT_TOKENS"
fi
export DSH_EVAL_TIMEOUT_SEC="$TIMEOUT_SEC"
export DSH_EVAL_REASONING="$EFFORT"
export DSH_EVAL_CONTEXT_WINDOW="$DSH_WINDOW"
if [ -n "$MAX_OUTPUT_TOKENS" ]; then
	export DSH_EVAL_MAX_TOKENS="$MAX_OUTPUT_TOKENS"
fi
# 传给容器的 --ae 参数：空了就整个不要（harness 会用各家自己的默认值）
OUT_REMAN=(); OUT_DSH=(); OUT_CC=()
if [ -n "$MAX_OUTPUT_TOKENS" ]; then
	OUT_REMAN=(--ae "REMAN_EVAL_MAX_OUTPUT_TOKENS=$MAX_OUTPUT_TOKENS")
	OUT_DSH=(--ae "DSH_EVAL_MAX_TOKENS=$MAX_OUTPUT_TOKENS")
	OUT_CC=(--ae "CLAUDE_CODE_MAX_OUTPUT_TOKENS=$MAX_OUTPUT_TOKENS")
fi

echo "==> $AGENT：思考强度 $EFFORT，输出上限 ${MAX_OUTPUT_TOKENS:-不额外设置}，单场上限 ${TIMEOUT_SEC}s"
echo "    窗口：reman $REMAN_WINDOW / dsh $DSH_WINDOW / cc $CC_WINDOW（cc 压缩百分比 ${CC_COMPACT_PCT}%）"

case "$AGENT" in
	reman)
		if [ ! -f eval/.cache/build/reman-bundle.tar.gz ]; then echo "还没有打包：先跑 node eval/terminal-bench/bundle.mjs"; exit 1; fi
		exec "$HARBOR" run \
			-p "$DATASET" "${TASKS[@]}" \
			-a reman_agent:RemanRuntimeAgent \
			-m deepseek/deepseek-flash \
			--ae "REMAN_EVAL_TIMEOUT_SEC=$TIMEOUT_SEC" \
			--ae "REMAN_EVAL_REASONING=$EFFORT" \
			--ae "REMAN_EVAL_CONTEXT_WINDOW=$REMAN_WINDOW" \
			"${OUT_REMAN[@]}" \
			-o eval/evidence/terminal-bench --job-name "reman-$STAMP" -n 1 -k 1 --yes \
			"${EXTRA[@]}"
		;;
	cc)
		if [ ! -f eval/.cache/build/claude-bundle.tar.gz ]; then echo "还没有 Claude Code 离线包：先跑 node eval/terminal-bench/claude-bundle.mjs"; exit 1; fi
		# 容器里的 DNS 被宿主机的 Clash TUN 劫持成 198.18.x 假 IP，直连不通，要靠宿主机的转发代理。
		# 转发进程不随本脚本退出：别的试次可能正靠它连模型，关掉会把别人跑死。
		if ! (exec 3<>/dev/tcp/127.0.0.1/7898) 2>/dev/null; then
			nohup node eval/.cache/tools/proxy-relay.mjs >/dev/null 2>&1 &
			sleep 1
		fi
		ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
		ANTHROPIC_API_KEY="$DEEPSEEK_API_KEY" \
		exec "$HARBOR" run \
			-p "$DATASET" "${TASKS[@]}" \
			-a claude_code_npm:ClaudeCodeNpm \
			-m anthropic/deepseek-flash \
			--effort "$EFFORT" \
			--agent-timeout-multiplier "$(awk "BEGIN{printf \"%.4f\", $TIMEOUT_SEC/$TASK_AGENT_TIMEOUT_SEC}")" \
			--ae "HTTP_PROXY=$CONTAINER_PROXY" \
			--ae "HTTPS_PROXY=$CONTAINER_PROXY" \
			--ae "NO_PROXY=localhost,127.0.0.1,::1" \
			--ae "CLAUDE_CODE_MAX_CONTEXT_TOKENS=$CC_WINDOW" \
			"${OUT_CC[@]}" \
			--ae "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=$CC_COMPACT_PCT" \
			--agent-setup-timeout-multiplier 3 \
			-o eval/evidence/terminal-bench --job-name "cc-$STAMP" -n 1 -k 1 --yes \
			"${EXTRA[@]}"
		;;
	dsh)
		if [ ! -f eval/.cache/build/dsh-bundle.tar.gz ]; then echo "还没有 dsh 离线包：先跑 node eval/terminal-bench/dsh-bundle.mjs"; exit 1; fi
		if ! (exec 3<>/dev/tcp/127.0.0.1/7898) 2>/dev/null; then
			nohup node eval/.cache/tools/proxy-relay.mjs >/dev/null 2>&1 &
			sleep 1
		fi
		exec "$HARBOR" run \
			-p "$DATASET" "${TASKS[@]}" \
			-a dsh_agent:DshHarnessAgent \
			-m deepseek/deepseek-flash \
			--agent-timeout-multiplier "$(awk "BEGIN{printf \"%.4f\", $TIMEOUT_SEC/$TASK_AGENT_TIMEOUT_SEC}")" \
			--ae "DSH_EVAL_TIMEOUT_SEC=$TIMEOUT_SEC" \
			--ae "DSH_EVAL_REASONING=$EFFORT" \
			--ae "DSH_EVAL_CONTEXT_WINDOW=$DSH_WINDOW" \
			"${OUT_DSH[@]}" \
			--ae "DSH_EVAL_PROXY=$CONTAINER_PROXY" \
			--agent-setup-timeout-multiplier 3 \
			-o eval/evidence/terminal-bench --job-name "dsh-$STAMP" -n 1 -k 1 --yes \
			"${EXTRA[@]}"
		;;
	*)
		echo "不认识的 agent：$AGENT（只能是 reman、cc、dsh）"
		exit 1
		;;
esac
