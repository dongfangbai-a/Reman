import { create } from 'zustand';

/** Ctrl+K 要求对话列表的搜索框获得焦点；对话列表处理后清掉。 */
export const useSearchFocus = create<{ requested: boolean; request(): void; done(): void }>()(set => ({
	requested: false,
	request: () => set({ requested: true }),
	done: () => set({ requested: false }),
}));
