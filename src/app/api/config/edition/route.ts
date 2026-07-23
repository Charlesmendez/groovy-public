import { NextResponse } from "next/server";
import { getEdition, isSelfHosted } from "@/lib/config/edition";
import { getBrandName } from "@/lib/config/appConfig";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      edition: getEdition(),
      selfHosted: isSelfHosted(),
      brandName: getBrandName(),
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    }
  );
}
