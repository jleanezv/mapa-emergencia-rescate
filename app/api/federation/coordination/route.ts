import { NextResponse } from "next/server";
import { getCoordinationOverview } from "@/lib/coordination";

export const dynamic = "force-dynamic";

export async function GET() {
  const overview = await getCoordinationOverview();
  return NextResponse.json(
    { overview },
    {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
      },
    },
  );
}
