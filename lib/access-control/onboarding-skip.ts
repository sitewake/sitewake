import { getD1Binding } from "../../db";
import { getRuntimeSetting, putRuntimeSetting } from "../../db/runtime-settings-store";

/**
 * Whether this installation was told, once, not to ask for a password again.
 *
 * It is deliberately not part of the access policy. `enabled` there means
 * "a password exists but the gate is off", and before a password exists it is
 * false anyway — so using it to also mean "somebody chose to skip" would merge
 * two states that have to stay apart: one is about the policy, the other about
 * what the console may interrupt a person with.
 *
 * It is stored, not kept in the browser, because the same installation is
 * usually opened from more than one machine and being asked again on each of
 * them is the thing being avoided. Skipping stops the onboarding step from
 * blocking; it does not stop the console from saying the console is open —
 * that notice follows `configured`, so the two can never disagree.
 */
const SKIP_KEY = "console.access.onboardingSkipped";

type SkipRecord = { skipped: boolean; at: string };

export async function accessOnboardingSkipped(): Promise<boolean> {
  try {
    const row = await getRuntimeSetting<SkipRecord>(SKIP_KEY, getD1Binding());
    return row?.value?.skipped === true;
  } catch {
    // A read failure is not a decision. Treat it as "not skipped" so the step
    // is offered again rather than silently dropped — the same direction
    // `authorizeManagementSession` takes when it cannot read the policy.
    return false;
  }
}

export async function skipAccessOnboarding(): Promise<{ skipped: true }> {
  await putRuntimeSetting<SkipRecord>(
    SKIP_KEY,
    { skipped: true, at: new Date().toISOString() },
    getD1Binding(),
    "console",
  );
  return { skipped: true };
}
