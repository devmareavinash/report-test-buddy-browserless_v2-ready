export function executionHealth(functions: string[], loaded: Set<string>, optional = new Set(["script-agent-chat", "headless-trace"])) {
    const missing_required = functions.filter(name => !loaded.has(name) && !optional.has(name));
    const optional_capabilities = Object.fromEntries([...optional].map(name => [name, loaded.has(name) ? "available" : "unavailable"]));
    return { ok: missing_required.length === 0, degraded: [...optional].some(name => !loaded.has(name)), missing_required, optional_capabilities, loaded_functions: loaded.size, expected_functions: functions.length };
  }