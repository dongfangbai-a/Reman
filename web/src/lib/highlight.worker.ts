/** 代码高亮在这个 Worker 里做：大段代码高亮要几百毫秒，放在页面的主线程上会卡住页面。见 highlight.ts。 */

export interface IHighlightRequest {
	readonly id: number;
	readonly code: string;
	readonly language: string;
}

/** html 为 undefined：不认识的语言，或者高亮出错，显示纯文本。 */
export interface IHighlightResponse {
	readonly id: number;
	readonly html: string | undefined;
}

const scope = self as unknown as {
	onmessage: ((event: MessageEvent<IHighlightRequest>) => void) | null;
	postMessage(message: IHighlightResponse): void;
};

let shiki: Promise<typeof import('shiki')> | undefined;

async function highlight(code: string, language: string): Promise<string | undefined> {
	shiki ??= import('shiki');
	const { codeToHtml, bundledLanguages, bundledLanguagesAlias } = await shiki;
	const lang = language.toLowerCase();
	if (!(lang in bundledLanguages) && !(lang in bundledLanguagesAlias)) return undefined;
	try {
		return await codeToHtml(code, { lang, themes: { light: 'github-light', dark: 'github-dark' } });
	} catch {
		return undefined;
	}
}

scope.onmessage = event => {
	const { id, code, language } = event.data;
	void highlight(code, language).then(html => scope.postMessage({ id, html }), () => scope.postMessage({ id, html: undefined }));
};
