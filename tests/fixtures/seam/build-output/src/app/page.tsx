export default async function Dashboard() {
  const key = process.env.NEXT_PUBLIC_DASHBOARD_KEY;
  const res = await fetch("/api/ping/1");
  const data = await res.json();
  return { key, data };
}
