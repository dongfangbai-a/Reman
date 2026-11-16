import { createContext, useContext, type ReactNode } from 'react';
import type { IMember } from '../api/types.ts';

const PerspectiveContext = createContext<IMember | undefined>(undefined);

/** 视角页用谁的视角看对话。是真人时可以收发消息，是 AI 成员时只读。 */
export function PerspectiveProvider({ perspective, children }: { perspective: IMember; children: ReactNode }) {
	return <PerspectiveContext value={perspective}>{children}</PerspectiveContext>;
}

/** 在视角页里是用谁的视角，别的页是 undefined。 */
export function useOptionalPerspective(): IMember | undefined {
	return useContext(PerspectiveContext);
}

export function usePerspective(): IMember {
	const perspective = useContext(PerspectiveContext);
	if (!perspective) throw new Error('usePerspective 只能在视角页中使用');
	return perspective;
}
