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
