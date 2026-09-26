import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { types } from '../../../wailsjs/go/models';
import { CommandModal } from './CommandModal';

describe('CommandModal dirty state', () => {
  it('reports edits to the app close gate and clears them on unmount', () => {
    const onDirtyChange = vi.fn();
    const command = new types.CommandTemplate({
      id: 'cmd-1',
      name: 'Status',
      command: 'systemctl status nginx',
      category: 'Ops',
      description: '',
      tags: [],
    });
    const view = render(
      <CommandModal
        command={command}
        language="en"
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'systemctl restart nginx' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

// The modal used to pick these with an inline `lang === "zh-CN"` ternary, so
// they stayed Chinese under an English interface (and vice versa).
describe('CommandModal locale', () => {
  const existing = () => new types.CommandTemplate({
    id: 'cmd-1',
    name: 'Status',
    command: 'systemctl status nginx',
    category: 'Ops',
    description: '',
    tags: [],
  });

  it('titles an existing command in the interface language', () => {
    render(
      <CommandModal command={existing()} language="zh-CN" onClose={vi.fn()} onSave={vi.fn()} />,
    );

    expect(screen.getByText('编辑命令')).toBeInTheDocument();
  });

  it('reports the empty-name validation in the interface language', () => {
    render(
      <CommandModal
        command={new types.CommandTemplate({ id: '', name: '', command: 'ls', category: '', description: '', tags: [] })}
        language="zh-CN"
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /保存命令/ }));

    expect(screen.getByRole('alert')).toHaveTextContent('命令名称不能为空');
  });

  it('labels the discard confirmation in the interface language', () => {
    render(
      <CommandModal command={existing()} language="zh-CN" onClose={vi.fn()} onSave={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Status v2' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.getByRole('button', { name: '不保存' })).toBeInTheDocument();
  });
});
