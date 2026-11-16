import { CenteredMessage } from '../ui/CenteredMessage.tsx';
import { usePerspective } from './perspective.tsx';

/** 视角页没选对话时。 */
export function PerspectiveHome() {
	const perspective = usePerspective();
	return perspective.type === 'human'
		? <CenteredMessage title="选择一个对话" detail={`从左侧打开 ${perspective.name} 的对话，或点击列表右上角发起私聊。`} />
		: <CenteredMessage title={`正以 ${perspective.name} 的视角查看`} detail="可查看该成员参与的对话，但无法以其身份发送消息。" />;
}
