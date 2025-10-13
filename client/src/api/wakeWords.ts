import api from "./api";

export const listWakeWordModels = async () => {
  const response = await api.get("/api/wake-words");
  return response.data;
};

export const getWakeWordQueueStatus = async () => {
  const response = await api.get("/api/wake-words/queue");
  return response.data;
};

export const createWakeWordModel = async (payload: { phrase: string; options?: Record<string, unknown> }) => {
  const response = await api.post("/api/wake-words", payload);
  return response.data;
};

export const retrainWakeWordModel = async (id: string, options?: Record<string, unknown>) => {
  const response = await api.post(`/api/wake-words/${id}/retrain`, { options });
  return response.data;
};

export const deleteWakeWordModel = async (id: string) => {
  const response = await api.delete(`/api/wake-words/${id}`);
  return response.data;
};
