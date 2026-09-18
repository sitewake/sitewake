import { registerValidationRunner } from "@/db/site-agent-store";
import { runnerEnrollmentAuthorized, runnerJson, runnerOptions } from "../http";

export async function OPTIONS() { return runnerOptions(); }
export async function POST(request: Request) {
  if (!runnerEnrollmentAuthorized(request)) return runnerJson({ error: "runner_enrollment_unauthorized" }, 401);
  try {
    return runnerJson(await registerValidationRunner(await request.json()), 201);
  }
  catch { return runnerJson({ error: "runner_registration_failed", message: "Runner registration failed." }, 500); }
}
