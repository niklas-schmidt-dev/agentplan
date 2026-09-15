import { LibraryPage, type LibrarySearchParams } from "@/components/dashboard/library-page";

export const metadata = { title: "Dashboard" };

export default function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<LibrarySearchParams>;
}) {
  return <LibraryPage searchParams={searchParams} />;
}
