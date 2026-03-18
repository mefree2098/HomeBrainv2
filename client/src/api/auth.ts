import api from './api';
import type { User } from "../../../shared/types/user";

export type RegistrationStatus = {
  registrationOpen: boolean;
  userCount: number;
  hasActiveAdmin: boolean;
}

// Description: Login user functionality
// Endpoint: POST /api/auth/login
// Request: { email: string, password: string }
// Response: { accessToken: string, refreshToken: string }
export const login = async (email: string, password: string) => {
  try {
    const response = await api.post('/api/auth/login', { email, password });
    return response.data;
  } catch (error) {
    console.error('Login error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Register user functionality
// Endpoint: POST /api/auth/register
// Request: { email: string, password: string }
// Response: { email: string }
export const register = async (email: string, password: string) => {
  try {
    const response = await api.post('/api/auth/register', {email, password});
    return response.data;
  } catch (error) {
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Logout
// Endpoint: POST /api/auth/logout
// Request: {}
// Response: { success: boolean, message: string }
export const logout = async () => {
  try {
    return await api.post('/api/auth/logout');
  } catch (error) {
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const getCurrentUser = async (): Promise<User> => {
  try {
    const response = await api.get('/api/auth/me');
    return response.data as User;
  } catch (error) {
    throw new Error(error?.response?.data?.message || error.message);
  }
};

export const getRegistrationStatus = async (): Promise<RegistrationStatus> => {
  try {
    const response = await api.get('/api/auth/registration-status');
    return response.data as RegistrationStatus;
  } catch (error) {
    throw new Error(error?.response?.data?.message || error.message);
  }
};
