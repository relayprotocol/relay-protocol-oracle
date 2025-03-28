// Safe wrapper to return `undefined` if a method call throws an error
export const undefinedOnThrow = async <T>(
  fn: (() => T) | (() => Promise<T>)
) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

// Reads a configuration value:
// - strings starting with "$" are assumed to point to environment variables
// - anything else is returned as-is
export const readConfigValue = (value: any) => {
  if (typeof value === "string" && value.startsWith("$")) {
    return process.env[value.slice(1)];
  }
  return value;
};
