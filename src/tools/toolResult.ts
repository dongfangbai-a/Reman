import type { CallToolResult } from '@modelcontextprotocol/client';
import { invalid } from '../common/errors.ts';
import type { IToolImage, Resources } from '../resources/resources.ts';
import { clipToFile } from './toolOutputs.ts';
import type { IToolText } from './tools.ts';

/** 没写结构化结果的工具，脚本里拿到的返回类型。 */
export const NO_STRUCTURED_RETURNS = '{ text: string; images: InputImage[] }';

/** 直接调用时交给模型的文字上限：超过时保留开头和结尾，完整内容存成文件。工具结果的主要内容多在前面，开头留得多。 */
const HEAD_CHARS = 15_000;
const TAIL_CHARS = 5_000;
/** 直接调用时最多附几张图片，和 view_image、run_tool_script 一样。 */
const MAX_IMAGES = 10;

/** 把 MCP 形状的工具结果交给脚本和模型。MCP 工具和自定义工具共用。 */
export interface IToolResultHandler {
	/** 脚本里拿到的值：结构化结果，或者文字和图片。结果是出错时报错，文字就是原因，没有文字时用 emptyError。 */
	value(result: CallToolResult, emptyError: string): unknown;
	/** 直接调用时给模型看的内容：图片的位置写明编号和文件，文字和图片按上限截取。 */
	format(value: unknown): string | IToolText;
}

/**
 * structured：工具声明了结构化结果，有 structuredContent 时脚本里拿到它。图片存进资源目录，来源写「工具名 返回的第 N 张图片」。
 * outputDirectory：文字过长时完整内容存在这里，用到时才建。
 */
export function toolResultHandler(resources: Resources, toolName: string, structured: boolean, outputDirectory: string): IToolResultHandler {
	// 脚本里拿到工具写的文字或结构化结果；直接调用时给模型看的内容记在这里，截取到 format 时再做，脚本里用的结果不存文件。
	const shown = new WeakMap<object, IToolText>();
	const limit = (text: string) => clipToFile(text, HEAD_CHARS, TAIL_CHARS, outputDirectory, toolName);
	return {
		value(result, emptyError) {
			const { text, images, annotated } = convert(resources, result, toolName);
			if (result.isError) throw invalid(limit(text || emptyError));
			if (!structured || result.structuredContent === undefined) {
				const content = { text, images };
				shown.set(content, { text: annotated, images });
				return content;
			}
			const value: unknown = result.structuredContent;
			// 工具没写文字时，直接调用看结构化结果的 JSON。
			if (typeof value === 'object' && value !== null) {
				shown.set(value, { text: text ? annotated : [JSON.stringify(value, null, 2), annotated].filter(Boolean).join('\n'), images });
			}
			return value;
		},
		format(value) {
			const content = typeof value === 'object' && value !== null ? shown.get(value) : undefined;
			if (content) {
				const omitted = content.images.length - MAX_IMAGES;
				const note = omitted > 0 ? `\n\n[最多附上 ${MAX_IMAGES} 张图片，另有 ${omitted} 张未附上，需要时可用 view_image 查看]` : '';
				return { text: limit(content.text) + note, images: content.images.slice(0, MAX_IMAGES) };
			}
			if (!structured) return value as IToolText;
			return limit(JSON.stringify(value, null, 2));
		},
	};
}

/**
 * 结果里的文字和图片。音频和二进制资源不附上，只写明有这些内容。
 * annotated 是直接调用时给模型看的文字：图片的位置写明编号和文件，超过上限的写明未附上。
 */
function convert(resources: Resources, result: CallToolResult, toolName: string): { text: string; images: IToolImage[]; annotated: string } {
	const lines: string[] = [];
	const annotated: string[] = [];
	const images: IToolImage[] = [];
	const add = (line: string) => {
		lines.push(line);
		annotated.push(line);
	};
	for (const block of result.content ?? []) {
		switch (block.type) {
			case 'text':
				add(block.text);
				break;
			case 'image':
				try {
					const image = resources.toolImage(Buffer.from(block.data, 'base64'), `${toolName} 返回的第 ${images.length + 1} 张图片`);
					images.push(image);
					annotated.push(`[图片 ${images.length}，文件位于 ${image.path}${images.length > MAX_IMAGES ? '，未附上' : ''}]`);
				} catch {
					add('[图片，格式不支持，未附上]');
				}
				break;
			case 'audio':
				add('[音频，未附上]');
				break;
			case 'resource_link':
				add(`[资源：${block.name} ${block.uri}]`);
				break;
			case 'resource':
				add('text' in block.resource ? block.resource.text : `[资源：${block.resource.uri}，二进制内容未附上]`);
				break;
		}
	}
	return { text: lines.join('\n'), images, annotated: annotated.join('\n') };
}
