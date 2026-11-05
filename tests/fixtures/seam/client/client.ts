const API_BASE = "/api";

// fetch("/commented-out-users")

export async function createUser() {
  const res = await fetch(`${API_BASE}/users`, { method: "POST" });
  return res.json();
}

export async function listUsers() {
  return fetch(API_BASE + "/users?limit=5#section");
}

export async function loadLogo() {
  return fetch("/assets/logo.png");
}

export async function health() {
  return fetch("/health");
}

export async function v1Users() {
  return fetch("/v1/users");
}

export async function axiosV1Users() {
  return axios.get("/api/v1/users");
}

export async function kyV1Users() {
  return ky.post("/api/v1/users");
}
