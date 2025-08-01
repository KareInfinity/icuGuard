import {userActions, userReducers, selectUsername, selectHasCompletedSetup} from '../redux/user.redux';

describe('User Redux Slice', () => {
  const initialState = {
    username: '',
    isFirstTime: true,
    hasCompletedSetup: false,
  };

  it('should handle initial state', () => {
    expect(userReducers(undefined, {type: 'unknown'})).toEqual(initialState);
  });

  it('should handle setUsername', () => {
    const username = 'John Doe';
    const actual = userReducers(initialState, userActions.setUsername(username));
    expect(actual.username).toEqual(username);
    expect(actual.hasCompletedSetup).toEqual(true);
    expect(actual.isFirstTime).toEqual(false);
  });

  it('should handle completeSetup', () => {
    const actual = userReducers(initialState, userActions.completeSetup());
    expect(actual.hasCompletedSetup).toEqual(true);
    expect(actual.isFirstTime).toEqual(false);
  });

  it('should handle resetUser', () => {
    const stateWithUser = {
      username: 'John Doe',
      isFirstTime: false,
      hasCompletedSetup: true,
    };
    const actual = userReducers(stateWithUser, userActions.resetUser());
    expect(actual).toEqual(initialState);
  });

  it('should select username correctly', () => {
    const state = {
      user: {
        username: 'John Doe',
        isFirstTime: false,
        hasCompletedSetup: true,
      },
    };
    expect(selectUsername(state as any)).toEqual('John Doe');
  });

  it('should select hasCompletedSetup correctly', () => {
    const state = {
      user: {
        username: 'John Doe',
        isFirstTime: false,
        hasCompletedSetup: true,
      },
    };
    expect(selectHasCompletedSetup(state as any)).toEqual(true);
  });
}); 