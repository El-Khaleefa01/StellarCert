import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { tokenStorage, notifyTokenRefreshed } from '../api/tokens';
import { User, UserRole } from '../api/types';
import { authApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  authApi: {
    refresh: vi.fn().mockRejectedValue(new Error('No refresh cookie')),
  },
}));

/** Build a JWT-shaped token whose `exp` is `offsetSec` from now. */
const makeToken = (offsetSec: number): string => {
  const payload = btoa(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + offsetSec }),
  );
  return `header.${payload}.signature`;
};

const sampleUser: User = {
  id: '1',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Doe',
  role: UserRole.USER,
};

const Consumer: React.FC = () => {
  const { isAuthenticated, user } = useAuth();
  return (
    <div>
      <span data-testid="auth">{String(isAuthenticated)}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>
    </div>
  );
};

const renderAuth = () =>
  render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>,
  );

beforeEach(() => {
  tokenStorage.clearTokens();
  vi.clearAllMocks();
  vi.mocked(authApi.refresh).mockReset().mockRejectedValue(new Error('No refresh cookie'));
});

describe('AuthContext bootstrap (#960)', () => {
  it('gates children until the initial refresh attempt completes', async () => {
    let resolveRefresh!: (response: {
      accessToken: string;
      user: User;
    }) => void;
    const refreshPromise = new Promise<{ accessToken: string; user: User }>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.mocked(authApi.refresh).mockReturnValue(refreshPromise);

    renderAuth();

    // Protected consumers must not render while the initial auth bootstrap is pending.
    expect(screen.queryByTestId('auth')).toBeNull();
    expect(screen.queryByTestId('user')).toBeNull();

    resolveRefresh({
      accessToken: makeToken(3600),
      user: sampleUser,
    });

    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('true');
      expect(screen.getByTestId('user').textContent).toBe('alice@example.com');
    });
    expect(authApi.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the existing in-memory access token is expired', async () => {
    tokenStorage.setAccessToken(makeToken(-100));
    vi.mocked(authApi.refresh).mockResolvedValue({
      accessToken: makeToken(3600),
      user: sampleUser,
    });

    renderAuth();

    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('true');
    });

    expect(authApi.refresh).toHaveBeenCalledTimes(1);
    expect(tokenStorage.getAccessToken()).toBeTruthy();
  });
});

describe('AuthContext silent token refresh (#560)', () => {
  it('flips isAuthenticated to true and sets the user after a silent refresh', async () => {
    // Start unauthenticated (no token, no user).
    renderAuth();

    await act(async () => {
      // Allow initial rehydration promise to resolve
    });

    expect(screen.getByTestId('auth').textContent).toBe('false');
    expect(screen.getByTestId('user').textContent).toBe('none');

    // Simulate apiClient's background refresh writing a fresh token + user.
    act(() => {
      tokenStorage.setAccessToken(makeToken(3600));
      notifyTokenRefreshed(makeToken(3600), sampleUser);
    });

    // Context updates immediately — no waiting for the 5-minute expiry check.
    expect(screen.getByTestId('auth').textContent).toBe('true');
    expect(screen.getByTestId('user').textContent).toBe('alice@example.com');
  });

  it('updates the user object from the refresh response', async () => {
    tokenStorage.setAccessToken(makeToken(3600));

    renderAuth();

    await act(async () => {});

    act(() => {
      notifyTokenRefreshed(makeToken(3600), sampleUser);
    });

    expect(screen.getByTestId('user').textContent).toBe('alice@example.com');

    const updated: User = { ...sampleUser, email: 'alice.new@example.com' };
    act(() => {
      tokenStorage.setAccessToken(makeToken(3600));
      notifyTokenRefreshed(makeToken(3600), updated);
    });

    expect(screen.getByTestId('user').textContent).toBe('alice.new@example.com');
    expect(screen.getByTestId('auth').textContent).toBe('true');
  });

  it('keeps isAuthenticated false when a refresh carries no user', async () => {
    tokenStorage.setAccessToken(makeToken(-100)); // expired going in

    renderAuth();

    await act(async () => {});

    expect(screen.getByTestId('auth').textContent).toBe('false');

    act(() => {
      notifyTokenRefreshed(makeToken(3600));
    });
    expect(screen.getByTestId('auth').textContent).toBe('false');
  });

  it('ignores a refreshed token that is already expired', async () => {
    renderAuth();

    await act(async () => {});

    act(() => {
      notifyTokenRefreshed(makeToken(-100), sampleUser);
    });
    // Expired token must not authenticate.
    expect(screen.getByTestId('auth').textContent).toBe('false');
  });
});
