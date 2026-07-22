import { getAuth } from "@/lib/auth/auth";

export const runtime = "nodejs";

const handler = (req: Request) => getAuth().handler(req);

export { handler as GET, handler as POST };
