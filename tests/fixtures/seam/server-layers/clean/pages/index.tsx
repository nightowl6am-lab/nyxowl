import type { GetServerSideProps } from "next";

export async function getServerSideProps(_ctx: unknown): Promise<GetServerSidePropsResult> {
  const res = await fetch("/api/users");
  const data = await res.json();
  return { props: { userTotal: data.total } };
}

export default function Dashboard() {
  return null;
}
