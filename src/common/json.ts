import { readFileSync } from 'node:fs';

/** 是不是普通对象：不是 null，也不是数组。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按 JSON 解析，先去掉开头的 BOM：Windows 上有的编辑器和 PowerShell 写 UTF-8 时会加上。 */
export function parseJson(text: string): unknown {
	return JSON.parse(text.replace(/^﻿/, ''));
}

/** 读一个 JSON 文件，开头有 BOM 时去掉。 */
export function readJsonFile(path: string): unknown {
	return parseJson(readFileSync(path, 'utf8'));
}
