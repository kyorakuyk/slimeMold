import { useEffect } from 'react';
import type { useReactFlow } from '@xyflow/react';

type ReactFlowActions = ReturnType<typeof useReactFlow>;
type TopBarFlowActions = Pick<ReactFlowActions, 'zoomIn' | 'zoomOut' | 'fitView'>;

export function useTopBarKeyboardShortcuts(
  { zoomIn, zoomOut, fitView }: TopBarFlowActions,
  handleNewProject: () => void,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewProject();
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomIn();
      } else if (mod && e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.shiftKey && e.key === '1') {
        e.preventDefault();
        fitView({ padding: 0.2, duration: 200 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomIn, zoomOut, fitView]);
}
