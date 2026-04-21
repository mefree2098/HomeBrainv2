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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!getStoredUser();
  });
  const [currentUser, setCurrentUser] = useState<User | null>(() => getStoredUser());
  const [isLoading, setIsLoading] = useState(true);

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
    // Clean up legacy token storage from older browser builds. HttpOnly cookies
    // are cleared by the server through /api/auth/logout or failed refreshes.
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("accessToken");
    localStorage.removeItem("userData");
    setCurrentUser(null);
    setIsAuthenticated(false);
    setIsLoading(false);
  };

  const setAuthData = (userData: User) => {
    setStoredUser(userData);
    setIsLoading(false);
  };

  const refreshCurrentUser = async () => {
    const userData = await apiGetCurrentUser();
    setStoredUser(userData);
    return userData;
  };

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
  }, []);

  const login = async (email: string, password: string) => {
    try {
      setIsLoading(true);
      const response = await apiLogin(email, password);
      setAuthData(response as User);
      return response as User;
    } catch (error) {
      resetAuth();
      throw new Error(error?.message || 'Login failed');
    }
  };

  const register = async (email: string, password: string) => {
    try {
      setIsLoading(true);
      const response = await apiRegister(email, password);
      setAuthData(response as User);
      return response as User;
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
