import { SupervisorError } from "../../errors.js";

export interface DshConfigChoice {
  value?: string;
  name?: string;
}

export interface DshConfigOption {
  id?: string;
  name?: string;
  value?: string;
  currentValue?: string;
  options?: DshConfigOption[];
}

interface FlatChoice {
  value: string;
  name: string;
}

/**
 * DSH groups model choices by provider (`options[].options[]`), while
 * reasoning_effort is a flat list. Flatten both without assuming a fixed
 * nesting depth.
 */
export function flattenDshChoices(option: DshConfigOption | undefined): FlatChoice[] {
  if (!option) return [];
  const out: FlatChoice[] = [];
  const visit = (nodes: DshConfigOption[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (typeof node.value === "string") {
        out.push({
          value: node.value,
          name: typeof node.name === "string" ? node.name : node.value,
        });
      }
      visit(node.options);
    }
  };
  visit(option.options);
  return out;
}

export function findDshConfigOption(
  configOptions: DshConfigOption[] | undefined,
  id: string,
): DshConfigOption | undefined {
  return configOptions?.find((option) => option.id === id);
}

function parseModelValue(value: string): [string, string] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Older or unexpected choices may not be JSON pairs.
  }
  return null;
}

function describeModelChoices(choices: FlatChoice[]): string {
  const names = choices.slice(0, 12).map((choice) => {
    const pair = parseModelValue(choice.value);
    return pair ? `${pair[0]}/${pair[1]}` : choice.name;
  });
  const suffix = choices.length > names.length ? ", ..." : "";
  return `${names.join(", ")}${suffix}`;
}

/**
 * Resolves the model config value DSH expects: a JSON pair of
 * `[provider, model]`. The caller may pass a display name or the model id.
 * An ambiguous display name (the same model is offered by two providers)
 * fails instead of guessing a provider.
 */
export function resolveDshModelValue(
  configOptions: DshConfigOption[] | undefined,
  selection: { model?: string; provider?: string },
): string | undefined {
  const option = findDshConfigOption(configOptions, "model");
  const choices = flattenDshChoices(option);
  if (selection.provider && !selection.model) {
    throw new SupervisorError(
      "BAD_REQUEST",
      "DSH model selection needs both provider and model; provider alone cannot identify a model.",
      { provider: selection.provider },
    );
  }
  if (!selection.model) return undefined;
  if (choices.length === 0) {
    throw new SupervisorError("UNSUPPORTED", "DSH did not advertise a model config option.");
  }

  const matches = choices.filter((choice) => {
    const pair = parseModelValue(choice.value);
    const modelMatches = choice.name === selection.model || pair?.[1] === selection.model;
    if (!modelMatches) return false;
    return selection.provider ? pair?.[0] === selection.provider : true;
  });

  if (matches.length === 0) {
    throw new SupervisorError(
      "BAD_REQUEST",
      `DSH does not offer model "${selection.model}"${
        selection.provider ? ` from provider "${selection.provider}"` : ""
      }. Available: ${describeModelChoices(choices)}.`,
      { model: selection.model, provider: selection.provider },
    );
  }
  if (matches.length > 1) {
    throw new SupervisorError(
      "BAD_REQUEST",
      `DSH offers model "${selection.model}" from more than one provider. Set provider explicitly.`,
      { model: selection.model, matches: matches.map((choice) => choice.value) },
    );
  }
  return matches[0]!.value;
}

/**
 * DSH exposes four reasoning levels. HS keeps the shared seven-level Pi
 * vocabulary and folds the levels DSH does not have.
 */
export function mapDshThinking(
  level: string,
): "off" | "low" | "high" | "max" {
  switch (level) {
    case "off":
      return "off";
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "max";
    default:
      throw new SupervisorError("BAD_REQUEST", `Unsupported thinking level: ${level}`);
  }
}

export function resolveDshReasoningValue(
  configOptions: DshConfigOption[] | undefined,
  thinking: string | undefined,
): string | undefined {
  if (!thinking) return undefined;
  const option = findDshConfigOption(configOptions, "reasoning_effort");
  if (!option) {
    throw new SupervisorError(
      "UNSUPPORTED",
      "DSH did not advertise a reasoning_effort option for this model; thinking cannot be applied.",
      { thinking },
    );
  }
  const mapped = mapDshThinking(thinking);
  const available = flattenDshChoices(option).map((choice) => choice.value);
  if (!available.includes(mapped)) {
    throw new SupervisorError(
      "UNSUPPORTED",
      `DSH does not offer reasoning_effort "${mapped}". Available: ${available.join(", ")}.`,
      { thinking, mapped },
    );
  }
  return mapped;
}
