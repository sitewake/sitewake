import { publicModelStatus } from "@/lib/model-config";
import { siteAgentJson, siteAgentOptions } from "../../http";

export async function OPTIONS() {
  return siteAgentOptions();
}

export async function GET() {
  return siteAgentJson(
    { execution: publicModelStatus("execution"), semantic: publicModelStatus("semantic"), adaptive: publicModelStatus("execution") },
    200,
    { "cache-control": "no-store" },
  );
}
