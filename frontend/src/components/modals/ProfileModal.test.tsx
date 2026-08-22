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

  // Description has to stay a multiline control. An <input> silently strips CR/LF
  // from its value, so swapping one in to compact the form would quietly discard
  // the line breaks of any existing profile the moment it was reopened and saved.
  it('keeps line breaks in the description field', () => {
    const onSave = vi.fn();
    // Mutate rather than spread: Profile is a class and spreading drops its
    // convertValues method.
    const profile = emptyProfile();
    profile.description = 'first line\nsecond line';
    render(
      <ProfileModal
        profile={profile}
        profiles={[]}
        language="en"
        onClose={vi.fn()}
        onSave={onSave}
        onPickKey={async () => ''}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    const description = screen.getByLabelText('Description');
    expect(description.tagName).toBe('TEXTAREA');
    expect((description as HTMLTextAreaElement).value).toBe('first line\nsecond line');

    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'example.test' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ description: 'first line\nsecond line' });
  });

  // The full editor is the only place a saved profile's jump can be viewed,
  // changed, or cleared — a compact-layout pass once deleted the selector,
  // leaving the jump settable only at creation time. The option list must also
  // exclude self-reference and profiles that jump themselves (chains cycle).
  it('edits the proxy jump without offering self-reference or chains', () => {
    const onSave = vi.fn();
    const editing = emptyProfile();
    editing.id = 'p-self';
    editing.name = 'Self';
    editing.host = 'self.test';
    const plain = emptyProfile();
    plain.id = 'p-plain';
    plain.name = 'Plain';
    plain.host = 'plain.test';
    const jumper = emptyProfile();
    jumper.id = 'p-jump';
    jumper.name = 'Jumper';
    jumper.host = 'jump.test';
    jumper.proxyJumpId = 'p-plain';

    render(
      <ProfileModal
        profile={editing}
        profiles={[editing, plain, jumper]}
        language="en"
        onClose={vi.fn()}
        onSave={onSave}
        onPickKey={async () => ''}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Proxy Jump') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'p-plain']);

    fireEvent.change(select, { target: { value: 'p-plain' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ proxyJumpId: 'p-plain' });
  });
});
