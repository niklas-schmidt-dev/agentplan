import { LibraryPage, type LibrarySearchParams } from "@/components/dashboard/library-page";

export const metadata = { title: "Group" };

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<LibrarySearchParams>;
}) {
  return <LibraryPage selectedGroupId={(await params).id} searchParams={searchParams} />;
}
