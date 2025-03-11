// Type for denoting lazy evaluation
export type Lazy<T> = () => Promise<T>;

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
