import { createContext, useContext, useState, ReactNode } from "react";
import { login as apiLogin, logout as apiLogout, register as apiRegister } from "../api/auth";
import { User } from "../../../shared/types/user";

type AuthContextType = {
  isAuthenticated: boolean;
  currentUser: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!localStorage.getItem("accessToken");
  });
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const userData = localStorage.getItem("userData");
    return userData ? JSON.parse(userData) : null;
  });

  const login = async (email: string, password: string) => {
    try {
      const response = await apiLogin(email, password);
      const { accessToken, refreshToken, ...userData } = response;
      setAuthData(accessToken, refreshToken, userData);
    } catch (error) {
      resetAuth();
      throw new Error(error?.message || 'Login failed');
    }
  };

  const register = async (email: string, password: string) => {
    try {
      const response = await apiRegister(email, password);
      const { accessToken, refreshToken, ...userData } = response;
      setAuthData(accessToken, refreshToken, userData);
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

  const clearAuthCookies = () => {
    const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `hbAccessToken=; Max-Age=0; path=/; SameSite=Lax${secureFlag}`;
    document.cookie = `hbSessionToken=; Max-Age=0; path=/; SameSite=Lax${secureFlag}`;
  };

  const resetAuth = () => {
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("accessToken");
    localStorage.removeItem("userData");
    setCurrentUser(null);
    setIsAuthenticated(false);
    clearAuthCookies();
  };

  const setAuthData = (accessToken, refreshToken, userData) => {
    if (accessToken || refreshToken) {
      localStorage.setItem("refreshToken", refreshToken);
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("userData", JSON.stringify(userData));
      setCurrentUser(userData);
      setIsAuthenticated(true);
      const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `hbAccessToken=${encodeURIComponent(accessToken)}; path=/; SameSite=Lax${secureFlag}`;
    } else {
      throw new Error('Neither refreshToken nor accessToken was returned.');
    }
  };

  return (
      <AuthContext.Provider value={{
        currentUser,
        isAuthenticated,
        login,
        register,
        logout
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
