import { describe, expect, it } from 'vitest';
import { types } from '../../../wailsjs/go/models';
import { emptyProfile } from '../../constants';

// ProfileModal decides "has unsaved edits" by comparing the draft against
// `new types.Profile(props.profile)` with JSON.stringify, which is key-order
// sensitive. If re-running a profile through the constructor reordered or
// normalized anything, the dialog would open already dirty and every close
// would raise a spurious discard prompt. These pin that assumption.
describe('profile dirty comparison', () => {
  it('is stable when a saved profile is re-wrapped', () => {
    const saved = new types.Profile({
      id: 'abc',
      name: 'prod-web',
      group: 'Default',
      host: '10.0.0.5',
      port: 22,
      username: 'root',
      authType: 'password',
      description: '',
      tags: [],
      favorite: false,
      cliEnabled: false,
      rememberPassword: true,
      autoReconnect: false,
      tunnels: [],
    });

    expect(JSON.stringify(new types.Profile(saved))).toBe(JSON.stringify(saved));
  });

  it('is stable for a brand new profile', () => {
    const fresh = emptyProfile();
    expect(JSON.stringify(new types.Profile(fresh))).toBe(JSON.stringify(fresh));
  });

  // This is the shape the modal's update() produces on every keystroke.
  it('detects a real edit but not a no-op spread', () => {
    const saved = emptyProfile();
    const untouched = new types.Profile({ ...saved });
    expect(JSON.stringify(untouched)).toBe(JSON.stringify(saved));

    const edited = new types.Profile({ ...saved, host: '10.0.0.9' });
    expect(JSON.stringify(edited)).not.toBe(JSON.stringify(saved));
  });
});
