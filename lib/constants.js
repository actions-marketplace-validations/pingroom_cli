// Endpoints and exit codes shared by every command surface.

export const BUILTIN_API = 'https://api.pingroom.io';
export const MCP_ENDPOINT = `${BUILTIN_API}/api/agent/mcp`;
export const DEFAULT_API = process.env.PINGROOM_API_URL || BUILTIN_API;

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, EXPIRED: 3, CANCELLED: 4 };
