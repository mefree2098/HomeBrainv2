import api from "./api";
import type { User, UserRole } from "../../../shared/types/user";

export type CreateUserPayload = {
  name?: string;
  email: string;
  password: string;
  role: UserRole;
  isActive?: boolean;
}

export type UpdateUserPayload = {
  name?: string;
  email?: string;
  role?: UserRole;
  isActive?: boolean;
}

const getErrorMessage = (error: any, fallback: string) => {
  return error?.response?.data?.message
    || error?.response?.data?.error
    || error?.message
    || fallback;
};

export const getUsers = async (): Promise<User[]> => {
  try {
    const response = await api.get("/api/users");
    return (response.data?.users || []) as User[];
  } catch (error: any) {
    throw new Error(getErrorMessage(error, "Failed to load users."));
  }
};

export const createUser = async (payload: CreateUserPayload): Promise<{ message: string; user: User }> => {
  try {
    const response = await api.post("/api/users", payload);
    return response.data as { message: string; user: User };
  } catch (error: any) {
    throw new Error(getErrorMessage(error, "Failed to create user."));
  }
};

export const updateUser = async (id: string, payload: UpdateUserPayload): Promise<{ message: string; user: User }> => {
  try {
    const response = await api.put(`/api/users/${id}`, payload);
    return response.data as { message: string; user: User };
  } catch (error: any) {
    throw new Error(getErrorMessage(error, "Failed to update user."));
  }
};

export const resetUserPassword = async (id: string, password: string): Promise<{ message: string }> => {
  try {
    const response = await api.post(`/api/users/${id}/reset-password`, { password });
    return response.data as { message: string };
  } catch (error: any) {
    throw new Error(getErrorMessage(error, "Failed to reset password."));
  }
};

export const deleteUser = async (id: string): Promise<{ message: string }> => {
  try {
    const response = await api.delete(`/api/users/${id}`);
    return response.data as { message: string };
  } catch (error: any) {
    throw new Error(getErrorMessage(error, "Failed to delete user."));
  }
};
