type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function parseArguments(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string" && parsed !== value) return parseArguments(parsed);
    return object(parsed);
  } catch { return undefined; }
}

function primitiveActionName(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function aliasActionName(value: string, allowed: Set<string>) {
  if (allowed.has(value)) return value;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases: Record<string, string[]> = {
    click_element_by_index: ["click", "click_element", "click_by_index", "tap", "press_element", "select_element"],
    input_text: ["input", "type", "fill", "fill_text", "enter_text", "text"],
    set_text_by_index: ["input_text", "input", "type", "fill", "fill_text", "enter_text", "text", "set_text"],
    insert_text_by_index: ["insert_text", "append_text", "type_at_caret"],
    select_dropdown_option: ["select", "select_option", "dropdown", "choose"],
    submit_form_by_index: ["submit", "submit_form", "request_submit"],
    move_focus: ["focus", "move_focus_forward", "move_focus_backward"],
    press_key_by_index: ["press_key", "key_press", "keyboard_key"],
    scroll: ["scroll_down", "scroll_up"],
    wait: ["sleep", "pause"],
    done: ["finish", "complete", "final"],
  };
  for (const [canonical, values] of Object.entries(aliases)) {
    if (allowed.has(canonical) && values.includes(normalized)) return canonical;
  }
  return undefined;
}

function schemaDefinitions(variants: JsonRecord[]) {
  return variants.flatMap((variant) => {
    const properties = object(variant.properties);
    if (!properties) return [];
    return Object.entries(properties).map(([name, schema]) => ({ name, schema: object(schema) }));
  });
}

function requiredKeys(schema?: JsonRecord) {
  return Array.isArray(schema?.required) ? schema.required.map(String) : [];
}

function rankActionInput(definitions: Array<{ name: string; schema?: JsonRecord }>, candidateInput: JsonRecord) {
  const inputKeys = new Set(Object.keys(candidateInput));
  return definitions.flatMap((definition) => {
    const required = requiredKeys(definition.schema);
    if (!required.length || !required.every((key) => inputKeys.has(key))) return [];
    return [{ name: definition.name, score: required.length * 10 - Math.abs(inputKeys.size - required.length) }];
  }).sort((left, right) => right.score - left.score);
}

function normalizeActionObject(action: JsonRecord, definitions: Array<{ name: string; schema?: JsonRecord }>) {
  const allowed = new Set(definitions.map((item) => item.name));
  const currentName = Object.keys(action)[0];
  if (currentName && allowed.has(currentName)) return action;

  const explicitName = primitiveActionName(action.action)
    || primitiveActionName(action.name)
    || primitiveActionName(action.type)
    || primitiveActionName(action.tool)
    || primitiveActionName(action.command)
    || (currentName ? aliasActionName(currentName, allowed) : undefined);
  const mappedName = explicitName ? aliasActionName(explicitName, allowed) : undefined;
  if (mappedName) {
    const aliasedCurrentInput = currentName && aliasActionName(currentName, allowed) === mappedName
      ? object(action[currentName])
      : undefined;
    const explicitInput = object(action.input) || object(action.args) || object(action.parameters) || object(action[mappedName]) || aliasedCurrentInput || action;
    const rest = { ...explicitInput };
    for (const key of ["action", "name", "type", "tool", "command", "args", "parameters"]) delete rest[key];
    return { [mappedName]: object(action.input) || object(action.args) || object(action.parameters) || rest };
  }

  if (!currentName) return undefined;
  const currentValue = action[currentName];
  const candidateInput = object(currentValue) || action;
  const ranked = rankActionInput(definitions, candidateInput);
  if (Object.keys(candidateInput).length === 1 && "index" in candidateInput && allowed.has("click_element_by_index")) {
    return { click_element_by_index: candidateInput };
  }
  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return undefined;
  return { [ranked[0].name]: candidateInput };
}

/**
 * Some OpenAI-compatible models flatten a discriminated action union, e.g.
 * `{action:{index:3}}` instead of
 * `{action:{click_element_by_index:{index:3}}}`. Recover the envelope from
 * the request's JSON Schema. This is protocol normalization only: it never
 * interprets page content or business outcomes.
 */
export function normalizeAgentToolEnvelope(requestBody: JsonRecord, responseBody: unknown) {
  const response = object(responseBody);
  const tools = Array.isArray(requestBody.tools) ? requestBody.tools : [];
  const agentTool = tools.map(object).find((tool) => object(tool?.function)?.name === "AgentOutput");
  const parameters = object(object(agentTool?.function)?.parameters);
  const actionSchema = object(object(parameters?.properties)?.action);
  const variants = (Array.isArray(actionSchema?.anyOf) ? actionSchema.anyOf : Array.isArray(actionSchema?.oneOf) ? actionSchema.oneOf : []).map(object).filter(Boolean) as JsonRecord[];
  if (!response || !variants.length) return responseBody;
  const definitions = schemaDefinitions(variants);

  const choices = Array.isArray(response.choices) ? response.choices : [];
  const firstChoice = object(choices[0]);
  const message = object(firstChoice?.message);
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const call = object(calls[0]);
  const fn = object(call?.function);
  const args = parseArguments(fn?.arguments);
  const action = object(args?.action) || parseArguments(args?.action);
  if (!args || !action) return responseBody;

  const normalizedAction = normalizeActionObject(action, definitions);
  if (!normalizedAction || normalizedAction === action) return responseBody;

  const normalizedArgs = { ...args, action: normalizedAction };
  return {
    ...response,
    choices: [{
      ...firstChoice,
      message: {
        ...message,
        tool_calls: [{ ...call, function: { ...fn, arguments: JSON.stringify(normalizedArgs) } }, ...calls.slice(1)],
      },
    }, ...choices.slice(1)],
  };
}
