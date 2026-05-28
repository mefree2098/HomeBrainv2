import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!getStoredUser();
  });
  const [currentUser, setCurrentUser] = useState<User | null>(() => getStoredUser());
  const [isLoading, setIsLoading] = useState(true);

  const setStoredUser = useCallback((userData: User | null) => {
    if (userData) {
      localStorage.setItem("userData", JSON.stringify(userData));
      setCurrentUser(userData);
      setIsAuthenticated(true);
      return;
    }

    localStorage.removeItem("userData");
    setCurrentUser(null);
  }, []);

  const resetAuth = useCallback(() => {
    // Clean up legacy token storage from older browser builds. HttpOnly cookies
    // are cleared by the server through /api/auth/logout or failed refreshes.
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("accessToken");
    localStorage.removeItem("userData");
    setCurrentUser(null);
    setIsAuthenticated(false);
    setIsLoading(false);
  }, []);

  const setAuthData = useCallback((userData: User) => {
    setStoredUser(userData);
    setIsLoading(false);
  }, [setStoredUser]);

  const refreshCurrentUser = useCallback(async () => {
    const userData = await apiGetCurrentUser();
    setStoredUser(userData);
    return userData;
  }, [setStoredUser]);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
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
  }, [resetAuth, setStoredUser]);

  const login = useCallback(async (email: string, password: string) => {
    try {
      setIsLoading(true);
      const response = await apiLogin(email, password);
      setAuthData(response as User);
      return response as User;
    } catch (error) {
      resetAuth();
      throw new Error(error?.message || 'Login failed');
    }
  }, [resetAuth, setAuthData]);

  const register = useCallback(async (email: string, password: string) => {
    try {
      setIsLoading(true);
      const response = await apiRegister(email, password);
      setAuthData(response as User);
      return response as User;
    } catch (error) {
      resetAuth();
      throw new Error(error?.message || 'Registration failed');
    }
  }, [resetAuth, setAuthData]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch (error) {
      console.warn("Logout request failed, clearing local auth state anyway.", error);
    } finally {
      resetAuth();
    }
  }, [resetAuth]);

  const isAdmin = useMemo(() => isAdminRole(currentUser?.role), [currentUser?.role]);
  const hasRole = useCallback((role: UserRole) => currentUser?.role === role, [currentUser?.role]);
  const hasPlatform = useCallback((platform: UserPlatform) => hasPlatformAccess(currentUser, platform), [currentUser]);
  const hasHomeBrainAccess = useMemo(() => hasPlatformAccess(currentUser, "homebrain"), [currentUser]);
  const value = useMemo(() => ({
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
  }), [
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
  ]);

  return (
      <AuthContext.Provider value={value}>
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
