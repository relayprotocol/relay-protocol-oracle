type RateLimitOptions = {
  max: number;
  windowMs: number;
  now?: () => number;
};

type RateLimitWindow = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
};

export const createFixedWindowRateLimiter = ({
  max,
  windowMs,
  now = Date.now,
}: RateLimitOptions) => {
  const windows = new Map<string, RateLimitWindow>();
  let requestCount = 0;

  return {
    check: (key: string): RateLimitResult => {
      const currentTime = now();
      requestCount += 1;

      if (requestCount % 1000 === 0) {
        for (const [windowKey, window] of windows) {
          if (window.resetAt <= currentTime) {
            windows.delete(windowKey);
          }
        }
      }

      const existingWindow = windows.get(key);
      const activeWindow =
        existingWindow && existingWindow.resetAt > currentTime
          ? existingWindow
          : { count: 0, resetAt: currentTime + windowMs };

      activeWindow.count += 1;
      windows.set(key, activeWindow);

      const remaining = Math.max(max - activeWindow.count, 0);

      return {
        allowed: activeWindow.count <= max,
        limit: max,
        remaining,
        resetMs: Math.max(activeWindow.resetAt - currentTime, 0),
      };
    },
  };
};
