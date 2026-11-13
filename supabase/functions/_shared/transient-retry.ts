export function isTransientFailure(error: any): boolean {
    const code = String(error?.code || error?.status || "");
    if (/^(22|23|28|42|PGRST1|401|403)/.test(code)) return false;
    if (/validation|unauthorized|forbidden|permission denied|invalid (input|shape)|not.null|foreign.key/i.test(String(error?.message || error))) return false;
    return /^(08|40|53|57|429|5\d\d)/.test(code) || /timeout|timed out|network|fetch failed|connection|temporar|unavailable|deadlock/i.test(String(error?.message || error));
  }
  export async function retryTransient<T>(operation: () => Promise<T>, getError: (result: T) => unknown, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await operation();
        const error = getError(result);
        if (!error || attempt >= attempts || !isTransientFailure(error)) return result;
      } catch (error) {
        if (attempt >= attempts || !isTransientFailure(error)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 150));
    }
  }