/** 表结构版本。版本对不上时直接清空重建；0.1.0 起改表结构的规矩见 DEVELOPMENT.md 的「表结构」。 */
export const SCHEMA_VERSION = 37;

export const SCHEMA_SQL = `
CREATE TABLE members (
	member_id TEXT PRIMARY KEY,
	-- 不区分大小写，彻底删除前一直占着，见下面的索引。
	name TEXT NOT NULL COLLATE NOCASE,
	type TEXT NOT NULL CHECK (type IN ('human', 'ai')),
	-- 以下到 definition_json 和最后的 memory 都来自 AI 成员的成员文件夹，由同步写入；成员删除后恢复时用它们重新生成成员文件夹。
	description TEXT NOT NULL DEFAULT '',
	prompt TEXT NOT NULL DEFAULT '',
	-- 用哪个供应商的哪个模型；都为空时用默认模型。
	model_provider TEXT,
	model TEXT CHECK ((model IS NULL) = (model_provider IS NULL)),
	reasoning_effort TEXT,
	-- 成员有哪些可设置的工具、能读哪些技能（JSON 数组）；为空表示用新成员的默认设置。
	tools_json TEXT,
	skills_json TEXT,
	-- 按运行时的格式重写的 member.json；私聊、群聊名单和时间感知用到时从这里读。
	definition_json TEXT NOT NULL DEFAULT '{}',
	-- 头像文件的版本（大小和修改时间），头像变了前端据此重新加载；没有头像、成员删除后为空。头像只在成员文件夹里，不存。
	avatar_hash TEXT,
	-- 没设置时用运行时给每个成员分配的默认目录。
	working_directory TEXT,
	created_at INTEGER NOT NULL,
	deleted_at INTEGER,
	-- 删除时解散和退出了哪些群聊、当时谁关注着，恢复时用（JSON）。
	deletion_json TEXT,
	-- 彻底删除：只留名字给对话里的消息显示发送者，名字空出来。
	purged_at INTEGER,
	-- 成员的记忆，运行时写记忆、同步时跟着更新。最长几千字，放在最后：列成员不取它，读它前面的列时不用读过它。
	memory TEXT NOT NULL DEFAULT '',
	CHECK (purged_at IS NULL OR deleted_at IS NOT NULL)
);

CREATE UNIQUE INDEX members_name_idx ON members (name COLLATE NOCASE) WHERE purged_at IS NULL;

CREATE TABLE groups (
	group_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	owner_member_id TEXT NOT NULL REFERENCES members(member_id),
	created_at INTEGER NOT NULL,
	dissolved_at INTEGER
);

CREATE TABLE group_members (
	group_id TEXT NOT NULL REFERENCES groups(group_id),
	member_id TEXT NOT NULL REFERENCES members(member_id),
	joined_at INTEGER NOT NULL,
	removed_at INTEGER,
	watching INTEGER NOT NULL DEFAULT 0 CHECK (watching IN (0, 1) AND (watching = 0 OR removed_at IS NULL)),
	PRIMARY KEY (group_id, member_id)
);

CREATE INDEX group_members_member_idx ON group_members (member_id, group_id);

CREATE TABLE messages (
	message_id INTEGER PRIMARY KEY,
	conversation_key TEXT NOT NULL,
	sender_member_id TEXT NOT NULL REFERENCES members(member_id),
	direct_member_id TEXT REFERENCES members(member_id),
	group_id TEXT REFERENCES groups(group_id),
	text TEXT NOT NULL,
	mention_all INTEGER NOT NULL DEFAULT 0 CHECK (mention_all IN (0, 1)),
	-- 真人成员代发的外部事件：来源和 meta（JSON）。
	external_json TEXT,
	-- AI 成员发的消息：发出它的那次调用在发送者时间线里的条目（send_message，或在脚本里调用时的 run_tool_script）。查历史据此判断它还在不在上下文里。
	sender_item_id INTEGER REFERENCES timeline_items(item_id),
	sent_at INTEGER NOT NULL,
	CHECK ((direct_member_id IS NULL) <> (group_id IS NULL)),
	CHECK (group_id IS NOT NULL OR mention_all = 0)
);

CREATE INDEX messages_conversation_idx ON messages (conversation_key, message_id);
-- 成员页找每个成员最后发出的消息；对话列表找私聊过的人，两边各一个，只收私聊的消息。
CREATE INDEX messages_sender_idx ON messages (sender_member_id, message_id);
CREATE INDEX messages_direct_sender_idx ON messages (sender_member_id, direct_member_id) WHERE direct_member_id IS NOT NULL;
CREATE INDEX messages_direct_recipient_idx ON messages (direct_member_id, sender_member_id) WHERE direct_member_id IS NOT NULL;
-- 压缩时找被摘要代替的调用发出的消息；也是外键的子列。
CREATE INDEX messages_sender_item_idx ON messages (sender_item_id) WHERE sender_item_id IS NOT NULL;

CREATE TABLE message_recipients (
	message_id INTEGER NOT NULL REFERENCES messages(message_id),
	member_id TEXT NOT NULL REFERENCES members(member_id),
	-- 和消息的 conversation_key 一样：数某个对话的未读、点名时只看这个对话里收到的那一段。
	conversation_key TEXT NOT NULL,
	mentioned INTEGER NOT NULL DEFAULT 0 CHECK (mentioned IN (0, 1)),
	PRIMARY KEY (message_id, member_id)
);

CREATE INDEX message_recipients_conversation_idx ON message_recipients (member_id, conversation_key, message_id);
CREATE INDEX message_recipients_mentioned_idx ON message_recipients (member_id, conversation_key, message_id) WHERE mentioned = 1;

-- 上传或成员发出的附件。文件按内容哈希存在资源目录里，resource_id 是相对资源目录的路径。
CREATE TABLE attachments (
	attachment_id TEXT PRIMARY KEY,
	resource_id TEXT NOT NULL,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
	mime_type TEXT NOT NULL,
	size INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE message_attachments (
	message_id INTEGER NOT NULL REFERENCES messages(message_id),
	position INTEGER NOT NULL,
	attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id),
	PRIMARY KEY (message_id, position)
);

CREATE TABLE runs (
	run_id INTEGER PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES members(member_id),
	kind TEXT NOT NULL CHECK (kind IN ('response', 'optimization')),
	status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
	error TEXT,
	-- 只在等审批的毫秒数：正在执行的工具调用全都在等审批的时间。运行用时是结束减开始再减掉它。
	waited_ms INTEGER NOT NULL DEFAULT 0,
	started_at INTEGER NOT NULL,
	ended_at INTEGER
);

CREATE INDEX runs_member_idx ON runs (member_id, run_id);

CREATE TABLE model_requests (
	request_id INTEGER PRIMARY KEY,
	run_id INTEGER NOT NULL REFERENCES runs(run_id),
	kind TEXT NOT NULL CHECK (kind IN ('response', 'optimization')),
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	seen_through_item_id INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
	input_tokens INTEGER,
	cached_tokens INTEGER,
	output_tokens INTEGER,
	error TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER
);

CREATE INDEX model_requests_run_idx ON model_requests (run_id, request_id);

CREATE TABLE timeline_items (
	item_id INTEGER PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES members(member_id),
	kind TEXT NOT NULL CHECK (kind IN ('message', 'group_event', 'model_output', 'tool_result', 'task_result', 'terminal_event', 'external_event', 'user_input', 'reminder', 'summary', 'omission', 'memory_change', 'pruning', 'optimization', 'change_notice', 'plan')),
	message_id INTEGER REFERENCES messages(message_id),
	request_id INTEGER REFERENCES model_requests(request_id),
	payload_json TEXT,
	wakes INTEGER NOT NULL CHECK (wakes IN (0, 1)),
	-- visible 进上下文；summarized 被摘要代替（summary_item_id 指向摘要）；pruned 被删掉；omitted 没看过的内容太多时拿出了上下文；
	-- unreturned 没有实际产出的一轮，写进来时就定下，不带回上下文。原内容都保留。
	context_state TEXT NOT NULL DEFAULT 'visible' CHECK (context_state IN ('visible', 'summarized', 'pruned', 'omitted', 'unreturned')),
	summary_item_id INTEGER REFERENCES timeline_items(item_id),
	-- 收到的内容在上下文里的位置：第一次看到它的回复请求，排在这次请求前面；还没被看到时为空。别的条目都为空（运行时设计第 5 部分「上下文里的先后」）。
	seen_request_id INTEGER REFERENCES model_requests(request_id),
	-- 收到的内容带的时间：上下文里内容编号后面的那段、写下的时刻、按哪个时区、是不是完整的时间。不带时都为空。
	time_text TEXT,
	time_at INTEGER,
	time_zone TEXT,
	time_full INTEGER CHECK (time_full IN (0, 1)),
	created_at INTEGER NOT NULL,
	CHECK ((kind = 'message') = (message_id IS NOT NULL)),
	CHECK ((kind IN ('model_output', 'tool_result')) = (request_id IS NOT NULL)),
	CHECK ((time_text IS NULL) = (time_at IS NULL) AND (time_text IS NULL) = (time_zone IS NULL) AND (time_text IS NULL) = (time_full IS NULL))
);

CREATE INDEX timeline_items_member_idx ON timeline_items (member_id, item_id);
-- 拼上下文只读在上下文里的条目；还没有位置的收到的内容，请求发出时记上位置。条件和 Timeline 里的查询写法一致才用得上。
CREATE INDEX timeline_items_context_idx ON timeline_items (member_id, item_id) WHERE context_state = 'visible';
CREATE INDEX timeline_items_unplaced_idx ON timeline_items (member_id, item_id) WHERE seen_request_id IS NULL AND request_id IS NULL;
-- 成员页找最近一次直接输出的文字。
CREATE INDEX timeline_items_output_idx ON timeline_items (member_id, item_id) WHERE kind = 'model_output' AND json_extract(payload_json, '$.type') = 'message';
-- 外键的子列：彻底删除成员时删时间线和请求，每删一行都要找指向它的行，没有索引就整表扫一遍。
CREATE INDEX timeline_items_summary_idx ON timeline_items (summary_item_id) WHERE summary_item_id IS NOT NULL;
-- 查历史时看收到的消息还在不在自己的上下文里；也是外键的子列。
CREATE INDEX timeline_items_message_idx ON timeline_items (message_id, member_id) WHERE message_id IS NOT NULL;
CREATE INDEX timeline_items_request_idx ON timeline_items (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX timeline_items_seen_request_idx ON timeline_items (seen_request_id) WHERE seen_request_id IS NOT NULL;

CREATE TABLE member_states (
	member_id TEXT PRIMARY KEY REFERENCES members(member_id),
	seen_through_item_id INTEGER NOT NULL DEFAULT 0,
	-- 最近一次压缩生效的时间；在这之前的请求用量不能再当作已知输入长度。
	optimized_at INTEGER NOT NULL DEFAULT 0,
	paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1))
);

-- 用户为成员设置的工具审批方式；没有记录时用工具的默认值。成员有哪些工具由成员文件夹决定。
CREATE TABLE tool_policies (
	member_id TEXT NOT NULL REFERENCES members(member_id),
	tool_name TEXT NOT NULL,
	policy TEXT NOT NULL CHECK (policy IN ('ask', 'auto', 'allow')),
	PRIMARY KEY (member_id, tool_name)
);

CREATE TABLE approvals (
	approval_id INTEGER PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES members(member_id),
	run_id INTEGER NOT NULL REFERENCES runs(run_id),
	call_id TEXT NOT NULL,
	-- run_tool_script 脚本里的第几次工具调用（从 0 开始）；直接调用时为空。
	nested_index INTEGER,
	tool_name TEXT NOT NULL,
	arguments_json TEXT NOT NULL,
	-- 工具按审批方式 auto 判断出来的短原因（JSON 数组）；每次都要审批时为空数组。
	reasons_json TEXT NOT NULL,
	-- 受保护的原因（JSON 数组）：改运行时的数据、读令牌和密钥。不为空时不管审批方式都要审批，只能允许这一次。
	protected_reasons_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
	reason TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	decided_at INTEGER
);

CREATE INDEX approvals_member_idx ON approvals (member_id, approval_id);
-- 待审批的：审批只增不减，网页端打开、每次审批有变化都要列一遍待审批的。查询要写明 status = 'pending' 才用得上。
CREATE INDEX approvals_pending_idx ON approvals (approval_id) WHERE status = 'pending';
CREATE INDEX approvals_run_idx ON approvals (run_id);

-- run_tool_script 脚本里的每一次工具调用。进模型上下文的只有脚本最后的输出，这些记录供时间线视图展开查看。
CREATE TABLE code_calls (
	member_id TEXT NOT NULL REFERENCES members(member_id),
	run_id INTEGER NOT NULL REFERENCES runs(run_id),
	call_id TEXT NOT NULL,
	call_index INTEGER NOT NULL,
	tool_name TEXT NOT NULL,
	arguments_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
	output TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	PRIMARY KEY (run_id, call_id, call_index)
);

CREATE TABLE tasks (
	task_id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES members(member_id),
	run_id INTEGER NOT NULL REFERENCES runs(run_id),
	call_id TEXT NOT NULL,
	tool_name TEXT NOT NULL,
	arguments_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
	output TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER
);

CREATE INDEX tasks_member_idx ON tasks (member_id, started_at);
CREATE INDEX tasks_run_idx ON tasks (run_id);

-- 成员的定时。time 是 time_zone 里的时刻：一次性的 2026-11-02 06:00，重复的 06:00；next_at 是下一次触发的时刻。
CREATE TABLE reminders (
	reminder_id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES members(member_id),
	note TEXT NOT NULL,
	time TEXT NOT NULL,
	time_zone TEXT NOT NULL,
	repeat TEXT NOT NULL CHECK (repeat IN ('none', 'day', 'weekday', 'week')),
	week_days_json TEXT NOT NULL,
	next_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX reminders_member_idx ON reminders (member_id, next_at);
CREATE INDEX reminders_next_idx ON reminders (next_at);

CREATE TABLE conversation_reads (
	member_id TEXT NOT NULL REFERENCES members(member_id),
	conversation_key TEXT NOT NULL,
	read_through_message_id INTEGER NOT NULL,
	PRIMARY KEY (member_id, conversation_key)
);

-- 网页端成员页的分组：使用者自己整理成员列表用的，不进任何成员的上下文。
CREATE TABLE member_sections (
	section_id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	position INTEGER NOT NULL
);

-- 一个成员可以在多个分组里；成员删除后照旧留着，恢复后还在原来的分组，彻底删除时去掉。
CREATE TABLE member_section_members (
	section_id TEXT NOT NULL REFERENCES member_sections(section_id),
	member_id TEXT NOT NULL REFERENCES members(member_id),
	PRIMARY KEY (section_id, member_id)
);

-- 成员的计划，成员用 update_plan 整份替换，全部完成时清空（items_json 是事项的 JSON 数组）。shown_item_id 是最近一份计划原文所在的时间线条目：
-- 直接调用的 update_plan，或压缩后放回的计划说明；在脚本里更新的、清空了的为空。每个成员一行。
CREATE TABLE plans (
	member_id TEXT PRIMARY KEY REFERENCES members(member_id),
	items_json TEXT NOT NULL,
	shown_item_id INTEGER REFERENCES timeline_items(item_id),
	updated_at INTEGER NOT NULL
);
-- 彻底删除成员时删时间线条目，每删一条都要查有没有计划指着它。
CREATE INDEX plans_shown_item_idx ON plans (shown_item_id) WHERE shown_item_id IS NOT NULL;

-- 使用者看到每个 AI 成员时间线的哪一条为止，网页端据此显示它有没有还没看过的新结果。
CREATE TABLE timeline_views (
	member_id TEXT PRIMARY KEY REFERENCES members(member_id),
	viewed_through_item_id INTEGER NOT NULL
);
`;
