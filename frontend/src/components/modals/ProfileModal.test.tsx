import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { emptyProfile } from '../../constants';
import { ProfileModal } from './ProfileModal';

describe('ProfileModal shortcuts', () => {
  it('does not save the obscured profile while the discard confirmation is open', () => {
    const onSave = vi.fn();
    render(
      <ProfileModal
        profile={emptyProfile()}
        profiles={[]}
        language="en"
        onClose={vi.fn()}
        onSave={onSave}
        onPickKey={async () => ''}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'example.test' } });
    const closeButton = document.querySelector<HTMLButtonElement>('.profile-modal-header button');
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton!);
    expect(screen.getByText('Discard your unsaved edits?')).toBeInTheDocument();

    const blockedSave = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(blockedSave);

    expect(blockedSave.defaultPrevented).toBe(true);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ host: 'example.test' });
  });
});
