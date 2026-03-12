// Fetch Kite token info from backend .env.local (via API endpoint)
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000/api/v1';

export async function getKiteTokenInfo() {
  return fetch(`${API_BASE}/token-info`).then(res => res.json());
}
