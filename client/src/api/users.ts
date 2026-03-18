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

export const getUsers = async (): Promise<User[]> => {
  const response = await api.get("/api/users");
  return (response.data?.users || []) as User[];
};

export const createUser = async (payload: CreateUserPayload): Promise<{ message: string; user: User }> => {
  const response = await api.post("/api/users", payload);
  return response.data as { message: string; user: User };
};

export const updateUser = async (id: string, payload: UpdateUserPayload): Promise<{ message: string; user: User }> => {
  const response = await api.put(`/api/users/${id}`, payload);
  return response.data as { message: string; user: User };
};

export const resetUserPassword = async (id: string, password: string): Promise<{ message: string }> => {
  const response = await api.post(`/api/users/${id}/reset-password`, { password });
  return response.data as { message: string };
};

export const deleteUser = async (id: string): Promise<{ message: string }> => {
  const response = await api.delete(`/api/users/${id}`);
  return response.data as { message: string };
};
