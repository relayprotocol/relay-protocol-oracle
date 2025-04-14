// Throw an error which can safely be passed-through externally
export const safeError = (message: string) => {
  const error = new Error(message);
  (error as any).isSafeError = true;
  throw error;
};

export const isSafeError = (error: any) => {
  return Boolean(error.isSafeError);
};
