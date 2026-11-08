const BASE = "/api";
const ABSOLUTE_BASE = "https://api.example.com";
const UNKNOWN = dynamicBase;

export async function unknownTemplate() {
  return fetch(`${UNKNOWN}/users`);
}

export async function unknownConcat() {
  return fetch(UNKNOWN + "/users");
}

export async function verbs() {
  await http.delete("/api/things/1");
  await client.patch("/api/things/1");
  await api.put("/api/things/1");
  await axios.get<Item>("/api/items/1");
  await ky.post("/api/items");
}

export async function search() {
  return fetch("/api/search?q=one#fragment");
}

export async function scriptAsset() {
  return fetch("/assets/app.js");
}

export async function absoluteUrl() {
  return fetch("https://example.com/external");
}

export async function expectedFields() {
  const res = await fetch("/api/profile");
  const data = await res.json();
  return data.name + data.email;
}

export async function concatKnownBase() {
  return fetch(BASE + "/health");
}
