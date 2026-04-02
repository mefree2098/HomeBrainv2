import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { getCurrentUser as apiGetCurrentUser, login as apiLogin, logout as apiLogout, register as apiRegister } from "../api/auth";
import { hasPlatformAccess, isAdminRole, type User, type UserPlatform, type UserRole } from "../../../shared/types/user";

type AuthContextType = {
  isAuthenticated: boolean;
  isLoading: boolean;
  isAdmin: boolean;
  hasHomeBrainAccess: boolean;
  currentUser: User | null;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refreshCurrentUser: () => Promise<User | null>;
  hasRole: (role: UserRole) => boolean;
  hasPlatform: (platform: UserPlatform) => boolean;
};

const AuthContext = createContext<AuthContextType | null>(null);

const getStoredUser = (): User | null => {
  try {
    const userData = localStorage.getItem("userData");
    return userData ? JSON.parse(userData) as User : null;
  } catch {
    return null;
  }
};

const getAccessTokenCookieOptions = (accessToken: string): string => {
  const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';

  try {
    const [, payloadSegment = ''] = accessToken.split('.');
    const normalizedPayload = payloadSegment
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(payloadSegment.length / 4) * 4, '=');
    const payload = JSON.parse(window.atob(normalizedPayload));
    const expSeconds = Number(payload?.exp);
    if (Number.isFinite(expSeconds)) {
      const maxAge = Math.max(0, Math.floor(expSeconds - (Date.now() / 1000)));
      return `; Max-Age=${maxAge}; path=/; SameSite=Lax${secureFlag}`;
    }
  } catch {
    // Fall back to a session cookie if the JWT cannot be decoded client-side.
  }

  return `; path=/; SameSite=Lax${secureFlag}`;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!localStorage.getItem("accessToken");
  });
  const [currentUser, setCurrentUser] = useState<User | null>(() => getStoredUser());
  const [isLoading, setIsLoading] = useState(() => !!localStorage.getItem("accessToken"));

  const clearAuthCookies = () => {
    const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `hbAccessToken=; Max-Age=0; path=/; SameSite=Lax${secureFlag}`;
    document.cookie = `hbSessionToken=; Max-Age=0; path=/; SameSite=Lax${secureFlag}`;
  };

  const syncAccessTokenCookie = (accessToken: string | null) => {
    if (!accessToken) {
      clearAuthCookies();
      return;
    }

    document.cookie = `hbAccessToken=${encodeURIComponent(accessToken)}${getAccessTokenCookieOptions(accessToken)}`;
  };

  const setStoredUser = (userData: User | null) => {
    if (userData) {
      localStorage.setItem("userData", JSON.stringify(userData));
      setCurrentUser(userData);
      setIsAuthenticated(true);
      return;
    }

    localStorage.removeItem("userData");
    setCurrentUser(null);
  };

  const resetAuth = () => {
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("accessToken");
    localStorage.removeItem("userData");
    setCurrentUser(null);
    setIsAuthenticated(false);
    setIsLoading(false);
    clearAuthCookies();
  };

  const setAuthData = (accessToken: string, refreshToken: string, userData: User) => {
    if (!accessToken && !refreshToken) {
      throw new Error('Neither refreshToken nor accessToken was returned.');
    }

    localStorage.setItem("refreshToken", refreshToken);
    localStorage.setItem("accessToken", accessToken);
    setStoredUser(userData);
    setIsLoading(false);
    syncAccessTokenCookie(accessToken);
  };

  const refreshCurrentUser = async () => {
    const accessToken = localStorage.getItem("accessToken");
    if (!accessToken) {
      resetAuth();
      return null;
    }

    const userData = await apiGetCurrentUser();
    setStoredUser(userData);
    return userData;
  };

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      if (!localStorage.getItem("accessToken")) {
        setIsLoading(false);
        return;
      }

      try {
        syncAccessTokenCookie(localStorage.getItem("accessToken"));
        const userData = await apiGetCurrentUser();
        if (cancelled) {
          return;
        }

        setStoredUser(userData);
      } catch (_error) {
        if (!cancelled) {
          resetAuth();
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (email: string, password: string) => {
    try {
      setIsLoading(true);
      const response = await apiLogin(email, password);
      const { accessToken, refreshToken, ...userData } = response;
      setAuthData(accessToken, refreshToken, userData as User);
      return userData as User;
    } catch (error) {
      resetAuth();
      throw new Error(error?.message || 'Login failed');
    }
  };

  const register = async (email: string, password: string) => {
    try {
      setIsLoading(true);
      const response = await apiRegister(email, password);
      const { accessToken, refreshToken, ...userData } = response;
      setAuthData(accessToken, refreshToken, userData as User);
      return userData as User;
    } catch (error) {
      resetAuth();
      throw new Error(error?.message || 'Registration failed');
    }
  };

  const logout = async () => {
    try {
      await apiLogout();
    } catch (error) {
      console.warn("Logout request failed, clearing local auth state anyway.", error);
    } finally {
      resetAuth();
    }
  };

  const isAdmin = useMemo(() => isAdminRole(currentUser?.role), [currentUser?.role]);
  const hasRole = (role: UserRole) => currentUser?.role === role;
  const hasPlatform = (platform: UserPlatform) => hasPlatformAccess(currentUser, platform);
  const hasHomeBrainAccess = hasPlatform("homebrain");

  return (
      <AuthContext.Provider value={{
        currentUser,
        isAuthenticated,
        isLoading,
        isAdmin,
        hasHomeBrainAccess,
        login,
        register,
        logout,
        refreshCurrentUser,
        hasRole,
        hasPlatform
      }}>
        {children}
      </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
