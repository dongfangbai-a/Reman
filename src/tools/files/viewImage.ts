import { readFileSync, statSync } from 'node:fs';
import { invalid } from '../../common/errors.ts';
import { detectImage, type IInputImage, type IToolImage, type Resources } from '../../resources/resources.ts';
import { resolveToolPath } from '../paths.ts';
import type { DataProtection } from '../protection.ts';
import type { ITool } from '../tools.ts';

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 一张图片的结果：读到了就有 image，读不了时 error 写原因。 */
export interface IViewedImage {
	readonly path: string;
	readonly image?: IToolImage;
	readonly error?: string;
}

/** 看本地图片：图片放进工具结果，模型直接看到。 */
export function createViewImageTool(resources: Resources, protection: DataProtection): ITool<IViewedImage[]> {
	return {
		name: 'view_image',
		label: '查看图片',
		progressive: true,
		description: '查看本地图片（png、jpeg、gif、webp）。一次可查看多张。',
		parameters: {
			type: 'object',
			properties: {
				paths: { type: 'array', items: { type: 'string' }, description: `图片路径，相对路径以工作目录为基准；最多 ${MAX_IMAGES} 张` },
			},
			required: ['paths'],
			additionalProperties: false,
		},
		returns: '{ path: string; image?: InputImage; error?: string }[]',
		defaultPolicy: 'allow',
		protectedReasons: (context, args) => protection.readReasons(imagePaths(context.workingDirectory, args['paths'])),
		execute(context, args) {
			const results = imagePaths(context.workingDirectory, args['paths']).map((absolute): IViewedImage => {
				const read = readImage(absolute);
				return typeof read === 'string' ? { path: absolute, error: read } : { path: absolute, image: resources.toolImage(read, absolute) };
			});
			if (results.every(result => !result.image)) throw invalid(results.map(result => `${result.path}：${result.error}`).join('\n'));
			return results;
		},
		format(results) {
			const images: IInputImage[] = [];
			const lines = results.map(result => {
				if (!result.image) return `${result.path}：${result.error}`;
				images.push(result.image);
				return `${result.path}：第 ${images.length} 张`;
			});
			return { text: lines.join('\n'), images };
		},
	};
}

/** 图片的绝对路径，相对路径从工作目录算起；参数不对时报错。 */
function imagePaths(workingDirectory: string, paths: unknown): string[] {
	if (!Array.isArray(paths) || paths.length === 0 || !paths.every(path => typeof path === 'string' && path.trim())) {
		throw invalid('paths 必须是非空的路径数组');
	}
	if (paths.length > MAX_IMAGES) throw invalid(`一次最多查看 ${MAX_IMAGES} 张图片`);
	return paths.map(path => resolveToolPath(workingDirectory, path as string));
}

/** 读一张图片；读不了时返回原因。 */
function readImage(path: string): Buffer | string {
	let size: number;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return '不是文件';
		size = stat.size;
	} catch {
		return '文件不存在';
	}
	if (size > MAX_IMAGE_BYTES) return `图片过大，最大 ${MAX_IMAGE_BYTES / 1024 / 1024} MB`;
	const bytes = readFileSync(path);
	if (!detectImage(bytes)) return '不支持的图片格式（仅支持 png、jpeg、gif、webp）';
	return bytes;
}
