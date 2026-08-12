import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalArea } from './TerminalArea';
import type { Tab } from '../../types';

vi.mock('../TabBar/TabBar', () => ({ TabBar: () => null }));
vi.mock('./TerminalStatusBar', () => ({ TerminalStatusBar: () => null }));

describe('TerminalArea split dragging', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('updates the grid live and commits split state only on pointer release', () => {
    const tabs = [
      { id: 'left', title: 'Left', state: 'connected' },
      { id: 'right', title: 'Right', state: 'connected' },
    ] as Tab[];
    const onSplitChange = vi.fn();
    const { container } = render(
      <TerminalArea
        tabs={tabs}
        activeTab="left"
        profiles={[]}
        terminalHosts={{ current: {} }}
        sidebarCollapsed={false}
        onToggleSidebar={vi.fn()}
        onActive={vi.fn()}
        onClose={vi.fn()}
        onReconnect={vi.fn()}
        onNewConnection={vi.fn()}
        language="en"
        splitPane={{ left: 'left', right: 'right', direction: 'horizontal', ratio: 0.5 }}
        onSplitChange={onSplitChange}
      />,
    );
    const stage = container.querySelector<HTMLElement>('.terminal-stage')!;
    stage.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600,
      width: 1000, height: 600, toJSON: () => ({}),
    });
    const divider = container.querySelector<HTMLElement>('.split-divider')!;

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 700, clientY: 300 });
    expect(onSplitChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 700, clientY: 300 });
    expect(onSplitChange).toHaveBeenCalledTimes(1);
    expect(onSplitChange).toHaveBeenCalledWith(expect.objectContaining({ ratio: 0.7 }));
  });
});
